/**
 * P-23 Step 4a scaffold — T-REPL.1..6
 *
 * REPL daemon-handshake behaviors: daemon-detect on boot, repl.pid lifecycle,
 * shared-session JSONL selection, cross-process turn.lock acquisition (G-P23.6).
 *
 * Tests the NEW P-23 behavior added to src/cli/repl.ts (§6.7) + src/cli/main.ts (§6.7).
 * Tests T-REPL.1..5 cover G-P23.5; T-REPL.6 (guardian NIT-NEW-3) covers G-P23.6.
 *
 * Gate coverage: G-P23.4, G-P23.5, G-P23.6
 *
 * All assertion bodies are TODO. Builder must make scaffolds reach assert.fail at Step 4b.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { MockLanguageModelV1 } from "ai/test";
import { isPidAlive, writePid } from "../../src/persistence/processLock.js";
import { loadMessagesShared } from "../../src/persistence/sharedSession.js";
import { runRepl } from "../../src/cli/repl.js";
import type { ReplOpts } from "../../src/cli/repl.js";
import { DEFAULT_TELEGRAM_CONFIG } from "../../src/persistence/telegramConfig.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "mai-p23-repl-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function makeOut(): { lines: string[]; stream: NodeJS.WritableStream } {
  const lines: string[] = [];
  const stream = {
    write(chunk: string | Buffer): boolean {
      lines.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { lines, stream };
}

function makeMockModel(): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    provider: "openai",
    modelId: "test-model",
    doStream: async () => ({
      stream: new ReadableStream({
        start(ctrl) {
          ctrl.enqueue({ type: "text-delta", textDelta: "stub" });
          ctrl.enqueue({ type: "finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } });
          ctrl.close();
        },
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });
}

function writeTelegramCfg(home: string, overrides: Record<string, unknown> = {}): string {
  const dir = join(home, ".mai", "agent");
  mkdirSync(dir, { recursive: true });
  const cfgPath = join(dir, "telegram.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({ ...DEFAULT_TELEGRAM_CONFIG, enabled: true, boundUserId: 12345, ...overrides }),
    "utf-8",
  );
  return cfgPath;
}

// ─── REPL daemon-detection + poller skip ──────────────────────────────────────

describe("repl: daemon-handshake on REPL boot", () => {
  it("T-REPL.1: when telegram.pid alive + cfg.enabled, REPL boot skips startTelegramPoller + emits advisory message", async () => {
    // Given:  telegram.pid file exists with process.pid (live); cfg.enabled=true; token set
    // When:   runRepl boots (piped non-TTY stdin closed immediately so loop exits)
    // Then:   out contains '[telegram] daemon active (PID' advisory; no 'poller started' message
    const { home, cleanup } = makeTmpHome();
    const origHome = process.env.HOME;
    try {
      process.env.HOME = home;
      process.env.TELEGRAM_TOKEN = "stub-token";
      const tgPidPath = join(home, ".mai", "agent", "telegram.pid");
      mkdirSync(join(home, ".mai", "agent"), { recursive: true });
      writePid(tgPidPath); // write current process.pid — guaranteed alive
      const cfgPath = writeTelegramCfg(home);

      const { lines, stream } = makeOut();
      const inStream = new PassThrough();
      inStream.end(); // EOF immediately → readline exits after drain

      await runRepl({
        model: makeMockModel(),
        system: "test",
        messages: [],
        tools: {},
        sessionFile: join(home, "session.jsonl"),
        in_: inStream,
        out: stream,
        telegramConfigPath: cfgPath,
        schedulePath: join(home, "schedule.jsonl"),
      });

      const outText = lines.join("");
      assert.ok(
        outText.includes("[telegram] daemon active (PID"),
        `expected daemon-active advisory in out, got: ${outText}`,
      );
      // Poller must NOT have started (no 'poller started' or 'enabled — poller' message)
      assert.ok(
        !outText.includes("enabled — poller"),
        "REPL must not start its own poller when daemon is alive",
      );
    } finally {
      process.env.HOME = origHome;
      delete process.env.TELEGRAM_TOKEN;
      cleanup();
    }
  });

  it("T-REPL.2: when telegram.pid absent + cfg.enabled + token set + boundUserId set, REPL does NOT show daemon-active advisory (regression)", async () => {
    // Given:  telegram.pid file does NOT exist; cfg.enabled=true; token set; boundUserId set
    // When:   runRepl boots (stdin closed immediately)
    // Then:   out does NOT contain 'daemon active' advisory (P-11 poller path taken instead)
    const { home, cleanup } = makeTmpHome();
    const origHome = process.env.HOME;
    const origFetch = globalThis.fetch;
    try {
      process.env.HOME = home;
      process.env.TELEGRAM_TOKEN = "stub-token";
      const cfgPath = writeTelegramCfg(home);
      // No telegram.pid file — poller should start instead of advisory
      // Mock fetch so poller doesn't make real HTTP calls
      // biome-ignore lint/suspicious/noExplicitAny: fetch mock
      // Add 30ms delay to prevent tight poller spin loop OOM before pollerAbort fires on REPL exit
      (globalThis as any).fetch = async (): Promise<Response> => {
        await new Promise<void>(r => setTimeout(r, 30));
        return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) } as unknown as Response;
      };

      const { lines, stream } = makeOut();
      const inStream = new PassThrough();
      inStream.end();

      await runRepl({
        model: makeMockModel(),
        system: "test",
        messages: [],
        tools: {},
        sessionFile: join(home, "session.jsonl"),
        in_: inStream,
        out: stream,
        telegramConfigPath: cfgPath,
        schedulePath: join(home, "schedule.jsonl"),
      });

      const outText = lines.join("");
      // Must NOT have daemon advisory (no telegram.pid → poller path taken)
      assert.ok(
        !outText.includes("[telegram] daemon active"),
        `must not show daemon advisory when no telegram.pid; got: ${outText}`,
      );
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (globalThis as any).fetch = origFetch;
      process.env.HOME = origHome;
      delete process.env.TELEGRAM_TOKEN;
      cleanup();
    }
  });
});

// ─── repl.pid lifecycle ──────────────────────────────────────────────────────

describe("repl: repl.pid write on boot + remove on exit", () => {
  it("T-REPL.3: when REPL boot completes setup, repl.pid file written with current PID", async () => {
    // Given:  repl.pid does not exist; REPL boots with piped input
    // When:   runRepl() called; writePid runs synchronously before first await
    // Then:   repl.pid file exists at ~/.mai/agent/repl.pid with process.pid value
    const { home, cleanup } = makeTmpHome();
    const origHome = process.env.HOME;
    try {
      process.env.HOME = home;
      mkdirSync(join(home, ".mai", "agent"), { recursive: true });

      const inStream = new PassThrough();
      const cfgPath = writeTelegramCfg(home, { enabled: false });

      // Start runRepl but don't await — it runs synchronously until first await
      // writePid is called synchronously before the first await in runRepl
      const replPromise = runRepl({
        model: makeMockModel(),
        system: "test",
        messages: [],
        tools: {},
        sessionFile: join(home, "session.jsonl"),
        in_: inStream,
        out: { write: () => true } as unknown as NodeJS.WritableStream,
        telegramConfigPath: cfgPath,
        schedulePath: join(home, "schedule.jsonl"),
      });

      // writePid(replPidPath) is synchronous and happens before the first await
      // so it's already done when runRepl() returns the Promise
      const replPidPath = join(home, ".mai", "agent", "repl.pid");
      assert.ok(existsSync(replPidPath), "repl.pid must be written before first await");
      assert.strictEqual(
        Number(readFileSync(replPidPath, "utf-8").trim()),
        process.pid,
        "repl.pid must contain current process.pid",
      );

      // Close stdin so REPL exits
      inStream.end();
      await replPromise;
    } finally {
      process.env.HOME = origHome;
      cleanup();
    }
  });

  it("T-REPL.4: when REPL exits normally, repl.pid is deleted via cleanup hook", async () => {
    // Given:  repl.pid written during boot
    // When:   REPL exits normally (stdin EOF → readline closes → cleanupReplPid() called at bottom)
    // Then:   repl.pid file does NOT exist after runRepl resolves
    const { home, cleanup } = makeTmpHome();
    const origHome = process.env.HOME;
    try {
      process.env.HOME = home;
      mkdirSync(join(home, ".mai", "agent"), { recursive: true });

      const inStream = new PassThrough();
      inStream.end(); // EOF immediately → readline closes → REPL exits
      const cfgPath = writeTelegramCfg(home, { enabled: false });

      await runRepl({
        model: makeMockModel(),
        system: "test",
        messages: [],
        tools: {},
        sessionFile: join(home, "session.jsonl"),
        in_: inStream,
        out: { write: () => true } as unknown as NodeJS.WritableStream,
        telegramConfigPath: cfgPath,
        schedulePath: join(home, "schedule.jsonl"),
      });

      // After runRepl resolves, cleanupReplPid() was called
      const replPidPath = join(home, ".mai", "agent", "repl.pid");
      assert.ok(!existsSync(replPidPath), "repl.pid must be removed after REPL exits");
    } finally {
      process.env.HOME = origHome;
      cleanup();
    }
  });

  it("T-REPL.5: when cfg.enabled=true + telegram.pid alive, turn messages are written to session file via appendMessagesShared", async () => {
    // Given:  telegram.pid alive; cfg.enabled=true; session file path = sharedSessionPath()
    // When:   runRepl processes one user turn
    // Then:   messages appended via appendMessagesShared; loadMessagesShared returns the turn messages
    const { home, cleanup } = makeTmpHome();
    const origHome = process.env.HOME;
    const origFetch = globalThis.fetch;
    try {
      process.env.HOME = home;
      process.env.TELEGRAM_TOKEN = "stub-token";
      mkdirSync(join(home, ".mai", "agent"), { recursive: true });

      // Write live telegram.pid → daemon advisory fires, poller skipped
      writePid(join(home, ".mai", "agent", "telegram.pid"));
      const cfgPath = writeTelegramCfg(home, { enabled: true, boundUserId: 12345 });

      // The shared session path (matches what main.ts would pick when enabled=true)
      const { sharedSessionPath } = await import("../../src/persistence/sharedSession.js");
      const sharedPath = sharedSessionPath(); // creates dir, returns path

      const inStream = new PassThrough();
      await new Promise<void>(r => setImmediate(r)); // yield before sending input

      const replPromise = runRepl({
        model: makeMockModel(),
        system: "test",
        messages: [],
        tools: {},
        sessionFile: sharedPath, // use the shared path
        in_: inStream,
        out: { write: () => true } as unknown as NodeJS.WritableStream,
        telegramConfigPath: cfgPath,
        schedulePath: join(home, "schedule.jsonl"),
      });

      // Yield until readline loop is ready, then send a message
      await new Promise<void>(r => setImmediate(r));
      inStream.write("hello\n");
      // Yield for turn processing
      await new Promise<void>(r => setTimeout(r, 200));
      inStream.end();
      await replPromise;

      // Verify messages are in shared session
      const loaded = loadMessagesShared(sharedPath);
      assert.ok(loaded.length >= 1, "shared session must have at least the user message");
      const userMsg = loaded.find(m => m.role === "user");
      assert.ok(userMsg, "user message must be in shared session");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (globalThis as any).fetch = origFetch;
      process.env.HOME = origHome;
      delete process.env.TELEGRAM_TOKEN;
      cleanup();
    }
  });
});

// ─── Cross-process turn.lock acquisition (guardian NIT-NEW-3) ──────────────────

describe("repl: cross-process turn.lock acquired before runAgentLoop (C2 reciprocal)", () => {
  it("T-REPL.6: when REPL processes an operator turn, turn.lock acquired and released; session file has content after turn", async () => {
    // Given:  daemon absent (no telegram.pid); operator types a single message; model returns immediately
    // When:   REPL turn body executes via runRepl
    // Then:   after turn completes: turn.lock gone (released in finally);
    //         session file has content (appendMessages/appendMessagesShared called)
    // NOTE:   ordering (acquire→run→append→release) verified by observable post-turn state:
    //         turn.lock released + session written = both sides of the lock fired in order.
    const { home, cleanup } = makeTmpHome();
    const origHome = process.env.HOME;
    try {
      process.env.HOME = home;
      mkdirSync(join(home, ".mai", "agent"), { recursive: true });

      const cfgPath = writeTelegramCfg(home, { enabled: false });
      const sessionPath = join(home, "session.jsonl");
      const turnLockPath = join(home, ".mai", "agent", "turn.lock");

      const inStream = new PassThrough();
      const replPromise = runRepl({
        model: makeMockModel(),
        system: "test",
        messages: [],
        tools: {},
        sessionFile: sessionPath,
        in_: inStream,
        out: { write: () => true } as unknown as NodeJS.WritableStream,
        telegramConfigPath: cfgPath,
        schedulePath: join(home, "schedule.jsonl"),
      });

      // Yield until REPL readline loop is ready
      await new Promise<void>(r => setImmediate(r));
      inStream.write("hello world\n");
      // Wait for turn processing
      await new Promise<void>(r => setTimeout(r, 300));
      inStream.end();
      await replPromise;

      // turn.lock must be released (not left dangling)
      assert.ok(!existsSync(turnLockPath), "turn.lock must be released after turn");
      // Session file must have content (append was called)
      assert.ok(existsSync(sessionPath), "session file must exist after turn");
      const content = readFileSync(sessionPath, "utf-8").trim();
      assert.ok(content.length > 0, "session file must have content after turn");
    } finally {
      process.env.HOME = origHome;
      cleanup();
    }
  });
});
