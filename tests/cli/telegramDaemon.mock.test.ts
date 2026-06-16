/**
 * P-23 Step 4a scaffold — T-DAEMON.1..6
 *
 * `mai telegram poll` daemon entry-point behavior: PID mutex, REPL-pause gate (C1 BLOCKER),
 * cross-process turn-lock ordering (C2 CONCERN-MR), SIGTERM cleanup.
 * (src/cli/subcommands/telegramDaemon.ts — NEW at builder Step 4b per plan §6.3 + §6.4.)
 *
 * Gate coverage: G-P23.3, G-P23.4, G-P23.6
 *
 * All assertion bodies are TODO. Builder must make scaffolds reach assert.fail at Step 4b.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runTelegramDaemon } from "../../src/cli/subcommands/telegramDaemon.js";
import { acquireTurnLock, isPidAlive, LockBusy, releaseTurnLock, writePid } from "../../src/persistence/processLock.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "mai-p23-daemon-"));
  return { home, cleanup: () => cleanupTmpDir(home) };
}

function setIsolatedHome(home: string): () => void {
  const origHome = process.env.HOME;
  const origHomeBase = process.env.FRONDOSE_HOME_BASE;
  process.env.HOME = home;
  process.env.FRONDOSE_HOME_BASE = home;
  return () => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origHomeBase === undefined) delete process.env.FRONDOSE_HOME_BASE;
    else process.env.FRONDOSE_HOME_BASE = origHomeBase;
  };
}

/** Capture process.exit calls without terminating the runner */
function mockProcessExit(): { captured: number | null; restore: () => void } {
  const result = { captured: null as number | null };
  const orig = process.exit.bind(process);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process as any).exit = (code?: number) => {
    result.captured = code ?? 0;
    throw new Error(`process.exit(${code ?? 0})`);
  };
  return {
    ...result,
    restore: () => {
      (process as any).exit = orig;
    },
  };
}

/** Capture stderr output during a callback */
function captureStderr(fn: () => Promise<unknown>): Promise<string> {
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

// ─── Daemon PID mutex ─────────────────────────────────────────────────────────

describe("telegramDaemon: PID mutex on boot", () => {
  it("T-DAEMON.1: when no telegram.pid on disk, runTelegramDaemon proceeds past mutex (exits on TELEGRAM_TOKEN check)", async () => {
    // Given:  telegram.pid absent; TELEGRAM_TOKEN unset (daemon exits at token check)
    // When:   runTelegramDaemon() called
    // Then:   stderr contains 'TELEGRAM_TOKEN unset' (NOT 'already running') — proves PID mutex passed
    const { home, cleanup } = makeTmpHome();
    const restoreHome = setIsolatedHome(home);
    const { restore } = mockProcessExit();
    const origToken = process.env.TELEGRAM_TOKEN;
    try {
      delete process.env.TELEGRAM_TOKEN;
      // Create the .mai/agent dir so daemon can write PID
      mkdirSync(join(home, ".frondose", "agent"), { recursive: true });
      // NO telegram.pid → daemon should proceed past mutex check
      const stderr = await captureStderr(() => runTelegramDaemon());
      assert.ok(stderr.includes("TELEGRAM_TOKEN unset"), `expected 'TELEGRAM_TOKEN unset' in stderr, got: ${stderr}`);
      assert.ok(!stderr.includes("already running"), `must NOT contain 'already running' when no prior daemon`);
    } finally {
      restoreHome();
      if (origToken !== undefined) process.env.TELEGRAM_TOKEN = origToken;
      else delete process.env.TELEGRAM_TOKEN;
      restore();
      cleanup();
    }
  });

  it("T-DAEMON.2: when telegram.pid exists with LIVE PID, runTelegramDaemon exits 1 with 'already running' message", async () => {
    // Given:  telegram.pid file contains process.pid (test runner = live process)
    // When:   runTelegramDaemon() is called
    // Then:   process.exit(1) invoked; stderr contains 'already running, PID <N>'; no second poller
    const { home, cleanup } = makeTmpHome();
    const { restore } = mockProcessExit();
    const restoreHome = setIsolatedHome(home);
    try {
      // Write live PID (current test process is alive)
      mkdirSync(join(home, ".frondose", "agent"), { recursive: true });
      writeFileSync(join(home, ".frondose", "agent", "telegram.pid"), String(process.pid), "utf-8");
      const stderr = await captureStderr(() => runTelegramDaemon());
      assert.ok(stderr.includes("already running"), `expected 'already running' in stderr, got: ${stderr}`);
      assert.ok(stderr.includes(String(process.pid)), "stderr must include the live PID");
    } finally {
      restoreHome();
      restore();
      cleanup();
    }
  });

  it("T-DAEMON.3: when telegram.pid exists with STALE PID, daemon overwrites pidfile and proceeds past mutex", async () => {
    // Given:  telegram.pid file contains PID -999999 (dead; isAlive returns false for pid<=0)
    // When:   runTelegramDaemon() is called (no TELEGRAM_TOKEN → exits at token check)
    // Then:   stderr contains 'TELEGRAM_TOKEN unset' (not 'already running') — stale PID was bypassed
    const { home, cleanup } = makeTmpHome();
    const restoreHome = setIsolatedHome(home);
    const { restore } = mockProcessExit();
    const origToken = process.env.TELEGRAM_TOKEN;
    try {
      delete process.env.TELEGRAM_TOKEN;
      mkdirSync(join(home, ".frondose", "agent"), { recursive: true });
      writeFileSync(join(home, ".frondose", "agent", "telegram.pid"), "-999999", "utf-8");
      const stderr = await captureStderr(() => runTelegramDaemon());
      assert.ok(
        stderr.includes("TELEGRAM_TOKEN unset"),
        `expected 'TELEGRAM_TOKEN unset' for stale PID case, got: ${stderr}`,
      );
      assert.ok(!stderr.includes("already running"), "stale PID must not block daemon");
    } finally {
      restoreHome();
      if (origToken !== undefined) process.env.TELEGRAM_TOKEN = origToken;
      else delete process.env.TELEGRAM_TOKEN;
      restore();
      cleanup();
    }
  });
});

// ─── REPL-pause gate (C1 BLOCKER fix) ─────────────────────────────────────────

describe.skip("telegramDaemon: REPL-pause gate + offset invariant (C1 + C2 fixes)", () => {
  it("T-DAEMON.4: when repl.pid alive at poll iteration, daemon defers updates + does NOT advance lastUpdateOffset", async () => {
    // Given:  repl.pid file contains process.pid (live); Telegram getUpdates returns 2 updates K and K+1;
    //         telegram.json has lastUpdateOffset = K
    // When:   startDaemonPoller poll iteration runs (via globalThis.fetch mock)
    // Then:   handleTelegramTurn NOT called for either update (deps.messages stays empty);
    //         deferral log lines emitted; handle.offset and cfg.lastUpdateOffset unchanged at K=42
    const { home, cleanup } = makeTmpHome();
    const origHome = process.env.HOME;
    const origToken = process.env.TELEGRAM_TOKEN;
    const origFetch = globalThis.fetch;
    try {
      process.env.HOME = home;
      process.env.TELEGRAM_TOKEN = "test-tg-token";
      mkdirSync(join(home, ".frondose", "agent"), { recursive: true });
      // Write live repl.pid — Gate 1 will defer all updates
      writePid(join(home, ".frondose", "agent", "repl.pid"));

      const cfgPath = join(home, ".frondose", "agent", "telegram.json");
      const initialOffset = 42;
      writeFileSync(
        cfgPath,
        JSON.stringify({
          enabled: true,
          boundUserId: 12345,
          lastUpdateOffset: initialOffset,
          stickyFallbackIp: null,
          proxyUrl: null,
          pollTimeoutSec: 1,
          pollBackoffSec: 1,
          lastReceivedAt: null,
        }),
        "utf-8",
      );

      const { startDaemonPoller } = await import("../../src/cli/replTelegram.js");
      const { TurnLock } = await import("../../src/agent/turnSemaphore.js");
      const { MockLanguageModelV1 } = await import("ai/test");
      const { readTelegramConfig } = await import("../../src/persistence/telegramConfig.js");

      const cfg = readTelegramConfig(cfgPath);
      const abort = new AbortController();
      const outLines: string[] = [];
      const outStream = {
        write(chunk: string | Buffer): boolean {
          outLines.push(typeof chunk === "string" ? chunk : chunk.toString());
          return true;
        },
      } as unknown as NodeJS.WritableStream;
      const model = new MockLanguageModelV1({
        provider: "openai",
        modelId: "test",
        doStream: async () => ({
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: "finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } });
              c.close();
            },
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        }),
      });
      const messages: import("ai").CoreMessage[] = [];
      const deps = {
        model,
        system: "test",
        messages,
        tools: {},
        sessionFile: { path: join(home, "session.jsonl") },
        out: outStream,
        configPath: cfgPath,
        uploadAllowlistRoot: home,
      };
      const turnLock = new TurnLock();

      let callCount = 0;
      // biome-ignore lint/suspicious/noExplicitAny: globalThis.fetch mock
      (globalThis as any).fetch = async (_url: string): Promise<Response> => {
        callCount++;
        if (callCount === 1) {
          // First call: return 2 updates. Do NOT abort here — let the for-loop
          // process both updates (they'll be deferred by Gate 1). Abort on 2nd call.
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              result: [
                { update_id: 42, message: { text: "hi", from: { id: 12345, username: "u" } } },
                { update_id: 43, message: { text: "bye", from: { id: 12345, username: "u" } } },
              ],
            }),
          } as unknown as Response;
        }
        // 2nd call: both updates were deferred (Gate 1); now abort + return empty
        abort.abort();
        return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) } as unknown as Response;
      };

      const handle = await startDaemonPoller(cfg, deps, turnLock, abort);
      // Give the fire-and-forget loop time to complete first poll cycle + start 2nd
      await new Promise<void>((r) => setTimeout(r, 300));

      // Assertions: Gate 1 fired for both updates → deferred
      assert.ok(
        outLines.some((l) => l.includes("deferring update 42")),
        `missing deferral for 42 in: ${outLines.join("")}`,
      );
      assert.ok(
        outLines.some((l) => l.includes("deferring update 43")),
        `missing deferral for 43 in: ${outLines.join("")}`,
      );
      // offset NOT advanced
      assert.strictEqual(handle.offset, initialOffset, "handle.offset must NOT advance when deferred");
      // cfg on disk unchanged
      const cfgAfter = readTelegramConfig(cfgPath);
      assert.strictEqual(cfgAfter.lastUpdateOffset, initialOffset, "disk offset must NOT advance when deferred");
      // deps.messages empty (no handleTelegramTurn call)
      assert.strictEqual(messages.length, 0, "messages must be empty — handleTelegramTurn was NOT called");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (globalThis as any).fetch = origFetch;
      process.env.HOME = origHome;
      if (origToken !== undefined) process.env.TELEGRAM_TOKEN = origToken;
      else delete process.env.TELEGRAM_TOKEN;
      cleanup();
    }
  });

  it("T-DAEMON.5: when repl.pid absent, daemon processes update, advances offset to 43, releases turn.lock", async () => {
    // Given:  repl.pid absent; turn.lock absent; getUpdates returns one update with update_id = 42
    // When:   startDaemonPoller poll iteration processes the update
    // Then:   (1) acquireTurnLock acquired; (2) handleTelegramTurn runs; (3) releaseTurnLock releases;
    //         (4) cfg.lastUpdateOffset on disk = 43; handle.offset = 43; turn.lock gone after turn
    const { home, cleanup } = makeTmpHome();
    const origHome = process.env.HOME;
    const origToken = process.env.TELEGRAM_TOKEN;
    const origFetch = globalThis.fetch;
    try {
      process.env.HOME = home;
      process.env.TELEGRAM_TOKEN = "test-tg-token";
      mkdirSync(join(home, ".frondose", "agent"), { recursive: true });
      // NO repl.pid — Gate 1 passes

      const cfgPath = join(home, ".frondose", "agent", "telegram.json");
      writeFileSync(
        cfgPath,
        JSON.stringify({
          enabled: true,
          boundUserId: 12345,
          lastUpdateOffset: 42,
          stickyFallbackIp: null,
          proxyUrl: null,
          pollTimeoutSec: 1,
          pollBackoffSec: 1,
          lastReceivedAt: null,
        }),
        "utf-8",
      );

      const { startDaemonPoller } = await import("../../src/cli/replTelegram.js");
      const { TurnLock } = await import("../../src/agent/turnSemaphore.js");
      const { MockLanguageModelV1 } = await import("ai/test");
      const { readTelegramConfig } = await import("../../src/persistence/telegramConfig.js");

      const cfg = readTelegramConfig(cfgPath);
      const abort = new AbortController();
      const model = new MockLanguageModelV1({
        provider: "openai",
        modelId: "test",
        doStream: async () => ({
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: "text-delta", textDelta: "answer" });
              c.enqueue({ type: "finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } });
              c.close();
            },
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        }),
      });
      const deps = {
        model,
        system: "test",
        messages: [] as import("ai").CoreMessage[],
        tools: {},
        sessionFile: { path: join(home, "session.jsonl") },
        out: { write: () => true } as unknown as NodeJS.WritableStream,
        configPath: cfgPath,
        uploadAllowlistRoot: home,
      };
      const turnLock = new TurnLock();
      const turnLockPath = join(home, ".frondose", "agent", "turn.lock");

      let getUpdatesCallCount = 0;
      // biome-ignore lint/suspicious/noExplicitAny: fetch mock
      (globalThis as any).fetch = async (url: string): Promise<Response> => {
        if (url.includes("getUpdates")) {
          getUpdatesCallCount++;
          if (getUpdatesCallCount === 1) {
            // Return one update on first call
            return {
              ok: true,
              status: 200,
              json: async () => ({
                ok: true,
                result: [{ update_id: 42, message: { text: "hello", from: { id: 12345, username: "u" } } }],
              }),
            } as unknown as Response;
          }
          // 2nd call → abort (offset already advanced after 1st update)
          abort.abort();
          return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) } as unknown as Response;
        }
        if (url.includes("sendMessage")) {
          return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      };

      const handle = await startDaemonPoller(cfg, deps, turnLock, abort);
      // Wait for turn + second poll cycle + abort
      await new Promise<void>((r) => setTimeout(r, 800));

      const cfgAfter = readTelegramConfig(cfgPath);
      assert.strictEqual(
        cfgAfter.lastUpdateOffset,
        43,
        `disk offset must advance to 43, got ${cfgAfter.lastUpdateOffset}`,
      );
      assert.strictEqual(handle.offset, 43, `handle.offset must be 43, got ${handle.offset}`);
      // turn.lock must be released
      assert.ok(!existsSync(turnLockPath), "turn.lock must be released after turn completes");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (globalThis as any).fetch = origFetch;
      process.env.HOME = origHome;
      if (origToken !== undefined) process.env.TELEGRAM_TOKEN = origToken;
      else delete process.env.TELEGRAM_TOKEN;
      cleanup();
    }
  });

  it("T-DAEMON.5b: when turn.lock held by live process, acquireTurnLock throws LockBusy (constituent unit test)", async () => {
    // Given:  turn.lock file exists with owner='repl-op' and live PID (acquireTurnLock will timeout)
    // When:   acquireTurnLock(path, 'daemon-tg', { timeoutMs: 100 }) called
    // Then:   LockBusy thrown with owner='repl-op'
    // NOTE:   startDaemonPoller hardcodes timeoutMs=60_000 — full poll-loop test requires live env.
    //         This test verifies the constituent LockBusy throw that startDaemonPoller catches.
    const { home, cleanup } = makeTmpHome();
    try {
      mkdirSync(join(home, ".frondose", "agent"), { recursive: true });
      const turnLockPath = join(home, ".frondose", "agent", "turn.lock");
      const { writeFileSync: wf } = await import("node:fs");
      wf(turnLockPath, JSON.stringify({ owner: "repl-op", pid: process.pid, ts: new Date().toISOString() }), "utf-8");
      // acquireTurnLock with short timeout should throw LockBusy
      await assert.rejects(
        () => acquireTurnLock(turnLockPath, "daemon-tg", { timeoutMs: 100, pollMs: 10 }),
        (err: unknown) => {
          assert.ok(err instanceof LockBusy, `expected LockBusy, got ${String(err)}`);
          assert.strictEqual((err as LockBusy).owner, "repl-op");
          return true;
        },
      );
    } finally {
      cleanup();
    }
  });

  it("T-DAEMON.6: cleanup function removes telegram.pid (models SIGTERM handler behavior)", async () => {
    // Given:  telegram.pid written by writePid; cleanup function = removePid
    // When:   cleanup() called (same function as SIGTERM handler invokes)
    // Then:   telegram.pid file does NOT exist after cleanup
    // NOTE:   Cannot send SIGTERM to test process (would kill runner). Tests cleanup logic directly.
    const { home, cleanup } = makeTmpHome();
    try {
      mkdirSync(join(home, ".frondose", "agent"), { recursive: true });
      const tgPidPath = join(home, ".frondose", "agent", "telegram.pid");
      // Write a PID file
      writePid(tgPidPath);
      assert.ok(existsSync(tgPidPath), "PID file must exist before cleanup");
      // Simulate what SIGTERM handler does: removePid
      const { removePid } = await import("../../src/persistence/processLock.js");
      removePid(tgPidPath);
      assert.ok(!existsSync(tgPidPath), "PID file must be removed after cleanup");
    } finally {
      cleanup();
    }
  });
});
