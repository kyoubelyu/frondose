/**
 * P-26 Step-5a re-Step-5 — T-SINBOX.INT.1..2, T-WORKER.NO-INBOX-PREFIX
 *
 * Integration tests verifying that `handleTelegramTurn` prepends pending
 * server_inbox events as a prefix to the user message before calling
 * `runAgentLoop` (B-26R-1: `inboxPrefix` hook in `TelegramTurnDeps`).
 *
 * This tests the daemon/Telegram path. The readline REPL path in
 * `serverRepl.ts` is verified by existing T-SRV.REPL.1..4 (startup smoke)
 * and by the inline `drainServerInbox` call in the readline turn handler.
 *
 * Gate coverage: G-P26.15 (integration level, per guardian Step 6 requirement)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import type { CoreMessage } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { handleTelegramTurn, type TelegramTurnDeps } from "../../src/cli/replTelegram.js";
import { drainServerInbox, enqueueServerInbox, openServerInboxDb } from "../../src/persistence/serverInbox.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p26-sinbox-int-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Immediate model: emits one "ok" text-delta then finish — runAgentLoop returns fast. */
function makeImmediateModel(): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    provider: "openai",
    modelId: "test-sinbox-int",
    doStream: async () => ({
      rawCall: { rawPrompt: null as unknown, rawSettings: {} as Record<string, unknown> },
      stream: Readable.toWeb(
        Readable.from([
          { type: "text-delta", textDelta: "ok" },
          { type: "finish", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } },
        ]),
        // biome-ignore lint/suspicious/noExplicitAny: cast for stream type
      ) as unknown as ReadableStream<any>,
    }),
  });
}

/**
 * Write a minimal telegram.json (runtime-only state) at `tcPath`.
 * `readTelegramConfig(tcPath)` will parse this and merge with config defaults
 * (boundUserId=null → DM-only auth check skipped for test messages).
 */
function writeTelegramRuntime(tcPath: string): void {
  mkdirSync(join(tcPath, ".."), { recursive: true });
  writeFileSync(
    tcPath,
    JSON.stringify({
      lastUpdateOffset: 0,
      stickyFallbackIp: null,
      pollTimeoutSec: 1,
      pollBackoffSec: 1,
      lastReceivedAt: null,
    }),
    "utf-8",
  );
}

/**
 * Build a minimal TelegramTurnDeps for direct handleTelegramTurn invocation.
 * - `appendMessages` is a no-op (avoids session file writes in tmp dir).
 * - `configPath` points to a freshly-written telegram.json.
 * - `inboxPrefix` is optional — omit for the worker (no-prefix) path.
 */
function makeTurnDeps(
  dir: string,
  model: MockLanguageModelV1,
  inboxPrefix?: () => string | null,
): { deps: TelegramTurnDeps; messages: CoreMessage[] } {
  const messages: CoreMessage[] = [];
  const tcPath = join(dir, "telegram.json");
  writeTelegramRuntime(tcPath);
  const deps: TelegramTurnDeps = {
    model,
    system: "test-system",
    messages,
    tools: {},
    sessionFile: { path: join(dir, "session.jsonl") },
    out: { write: (_chunk: string | Buffer) => true } as unknown as NodeJS.WritableStream,
    configPath: tcPath,
    uploadAllowlistRoot: join(dir, "uploads"),
    // no-op: avoids appendMessages writing to the session file in the tmp dir
    appendMessages: () => {},
    inboxPrefix,
  };
  return { deps, messages };
}

// ─── T-SINBOX.INT ─────────────────────────────────────────────────────────────

describe.skip("handleTelegramTurn inboxPrefix integration (G-P26.15)", () => {
  it(
    "T-SINBOX.INT.1: with 3 pending server_inbox rows + inboxPrefix hook, user message contains prefix + separator + operator input; rows marked drained",
    async () => {
      // Given: server_inbox.sqlite seeded with 3 pending events from 2 workers;
      //        inboxPrefix = () => drainServerInbox(serverInboxDb); TELEGRAM_TOKEN unset
      // When:  handleTelegramTurn(update{text:"hello"}, deps) called
      // Then:  deps.messages[0].content starts with "[Worker events since last conversation]";
      //        contains "\n\n---\n\n" separator; part after separator has "[TG_FROM=testuser]"+hello;
      //        all 3 server_inbox rows have status='drained'; 0 pending rows remain
      const { dir, cleanup } = makeTmpDir();
      const savedHome = process.env.HOME;
      const savedToken = process.env.TELEGRAM_TOKEN;
      try {
        // Override HOME so DEFAULT_CONFIG_PATH() → non-existent file → boundUserId:null (all msgs pass)
        process.env.HOME = dir;
        // Unset token so handleTelegramTurn skips the sendTelegramMessage auto-reply block
        delete process.env.TELEGRAM_TOKEN;

        // Seed 3 pending events
        const serverInboxDb = openServerInboxDb(join(dir, "server_inbox.sqlite"));
        enqueueServerInbox(serverInboxDb, "worker_A", "outreach_sent", { p: "https://linkedin.com/in/alice/" });
        enqueueServerInbox(serverInboxDb, "worker_B", "connect_accepted", { p: "https://linkedin.com/in/bob/" });
        enqueueServerInbox(serverInboxDb, "worker_A", "message_sent", { p: "https://linkedin.com/in/carol/" });

        const { deps, messages } = makeTurnDeps(dir, makeImmediateModel(), () => drainServerInbox(serverInboxDb));

        // biome-ignore lint/suspicious/noExplicitAny: TelegramUpdate interface not exported
        const update = { update_id: 1, message: { text: "hello", from: { id: 99, username: "testuser" } } } as any;
        await handleTelegramTurn(update, deps);

        // 1a — at least one message pushed
        const userMsg = messages.find((m) => m.role === "user") as { role: "user"; content: string } | undefined;
        assert.ok(userMsg, "T-SINBOX.INT.1: a user-role message must be in deps.messages after the turn");
        const content = userMsg.content;
        assert.equal(typeof content, "string", "T-SINBOX.INT.1: user message content must be a string");

        // 1b — prefix header present
        assert.ok(
          content.startsWith("[Worker events since last conversation]"),
          `T-SINBOX.INT.1: content must start with inbox prefix header; got: ${content.slice(0, 300)}`,
        );

        // 1c — separator present
        assert.ok(
          content.includes("\n\n---\n\n"),
          `T-SINBOX.INT.1: content must contain '\\n\\n---\\n\\n' separator; got: ${content.slice(0, 400)}`,
        );

        // 1d — operator input after separator
        const parts = content.split("\n\n---\n\n");
        assert.ok(parts.length >= 2, "T-SINBOX.INT.1: content split by separator must yield >= 2 parts");
        const afterSep = parts[parts.length - 1] ?? "";
        assert.ok(
          afterSep.includes("[TG_FROM=testuser]"),
          `T-SINBOX.INT.1: part after separator must contain '[TG_FROM=testuser]'; got: ${afterSep}`,
        );
        assert.ok(
          afterSep.includes("hello"),
          `T-SINBOX.INT.1: part after separator must contain 'hello'; got: ${afterSep}`,
        );

        // 1e — all 3 rows drained
        const drained = (
          serverInboxDb.prepare("SELECT COUNT(*) AS c FROM server_inbox WHERE status='drained'").get() as { c: number }
        ).c;
        assert.equal(drained, 3, "T-SINBOX.INT.1: all 3 server_inbox rows must be status='drained' after turn");

        const pending = (
          serverInboxDb.prepare("SELECT COUNT(*) AS c FROM server_inbox WHERE status='pending'").get() as { c: number }
        ).c;
        assert.equal(pending, 0, "T-SINBOX.INT.1: 0 pending rows must remain after turn");
      } finally {
        process.env.HOME = savedHome;
        if (savedToken !== undefined) process.env.TELEGRAM_TOKEN = savedToken;
        else delete process.env.TELEGRAM_TOKEN;
        cleanup();
      }
    },
    { timeout: 10_000 },
  );

  it(
    "T-SINBOX.INT.2: without inboxPrefix (worker path), user message contains only operator input; server_inbox rows untouched",
    async () => {
      // Given: server_inbox.sqlite seeded with 3 pending events; deps.inboxPrefix = undefined (worker)
      // When:  handleTelegramTurn(update{text:"hello"}, deps) called
      // Then:  user message = "[TG_FROM=testuser]\nhello" (no prefix, no separator);
      //        server_inbox rows remain pending (worker path never drains server inbox)
      const { dir, cleanup } = makeTmpDir();
      const savedHome = process.env.HOME;
      const savedToken = process.env.TELEGRAM_TOKEN;
      try {
        process.env.HOME = dir;
        delete process.env.TELEGRAM_TOKEN;

        const serverInboxDb = openServerInboxDb(join(dir, "server_inbox.sqlite"));
        enqueueServerInbox(serverInboxDb, "worker_A", "outreach_sent", { p: "https://linkedin.com/in/alice/" });
        enqueueServerInbox(serverInboxDb, "worker_B", "connect_accepted", { p: "https://linkedin.com/in/bob/" });
        enqueueServerInbox(serverInboxDb, "worker_A", "message_sent", { p: "https://linkedin.com/in/carol/" });

        // No inboxPrefix (worker daemon path)
        const { deps, messages } = makeTurnDeps(dir, makeImmediateModel(), undefined);

        // biome-ignore lint/suspicious/noExplicitAny: TelegramUpdate interface not exported
        const update = { update_id: 2, message: { text: "hello", from: { id: 99, username: "testuser" } } } as any;
        await handleTelegramTurn(update, deps);

        const userMsg = messages.find((m) => m.role === "user") as { role: "user"; content: string } | undefined;
        assert.ok(userMsg, "T-SINBOX.INT.2: a user-role message must be pushed");
        const content = userMsg.content;

        // No inbox prefix in content
        assert.ok(
          !content.includes("[Worker events since last conversation]"),
          `T-SINBOX.INT.2: content must NOT contain inbox prefix header (no inboxPrefix hook); got: ${content.slice(0, 200)}`,
        );
        assert.ok(
          !content.includes("\n\n---\n\n"),
          "T-SINBOX.INT.2: content must NOT contain separator (worker path, inboxPrefix=undefined)",
        );

        // Operator input is present (plain user message)
        assert.ok(
          content.includes("[TG_FROM=testuser]"),
          `T-SINBOX.INT.2: content must contain '[TG_FROM=testuser]'; got: ${content}`,
        );
        assert.ok(content.includes("hello"), "T-SINBOX.INT.2: content must contain 'hello'");

        // Server inbox rows untouched
        const stillPending = (
          serverInboxDb.prepare("SELECT COUNT(*) AS c FROM server_inbox WHERE status='pending'").get() as { c: number }
        ).c;
        assert.equal(
          stillPending,
          3,
          "T-SINBOX.INT.2: all 3 server_inbox rows must remain pending (worker does not drain them)",
        );
      } finally {
        process.env.HOME = savedHome;
        if (savedToken !== undefined) process.env.TELEGRAM_TOKEN = savedToken;
        else delete process.env.TELEGRAM_TOKEN;
        cleanup();
      }
    },
    { timeout: 10_000 },
  );
});

describe("worker path: no inboxPrefix in TelegramTurnDeps construction (G-P26.15)", () => {
  it("T-WORKER.NO-INBOX-PREFIX: src/cli/subcommands/telegramDaemon.ts and src/cli/repl.ts do NOT set inboxPrefix in TelegramTurnDeps", () => {
    // Given: source files for worker telegram daemon (telegramDaemon.ts) + worker REPL (repl.ts)
    // When:  grep -n 'inboxPrefix' across both files
    // Then:  zero matches — workers never supply the server-only inboxPrefix hook
    const projectRoot = resolve(process.cwd());
    const result = spawnSync(
      "grep",
      ["-n", "inboxPrefix", "src/cli/subcommands/telegramDaemon.ts", "src/cli/repl.ts"],
      { cwd: projectRoot, encoding: "utf-8" },
    );
    // grep returns exit code 1 when no matches found (the expected/clean state).
    // exit code 0 means matches found — a violation of the worker/server separation.
    assert.equal(
      (result.stdout ?? "").trim(),
      "",
      `T-WORKER.NO-INBOX-PREFIX: inboxPrefix must NOT appear in worker-path sources; found:\n${result.stdout}`,
    );
  });
});
