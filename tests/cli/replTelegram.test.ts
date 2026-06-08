/**
 * P-11 Step 5 — T-Slash.tg.1..7 + T-Turn.1..7 (filled assertions)
 * P-12 Step 4a — T-Session.1, T-Visibility.1..3 (scaffolds — TODO bodies)
 *
 * handleTelegramSlash, handleTelegramTurn, sendTelegramMessage
 * (src/cli/replTelegram.ts — NEW at builder Step 4b).
 *
 * P-Z3 (D-Z3-02): T-Poller.1..6 were SPLIT OUT into tests/cli/replTelegramPoller.test.ts so each
 * node:test subprocess gets its own ~4GB heap (telegramFetch creates an undici Agent per call;
 * running the pollers alongside the rest accumulated Agents → OOM). See replTelegramPoller header.
 *
 * Gate coverage: G-P11.15, G-P11.19, D-20, D-24 (P-11); G-P12.1, G-P12.3 (P-12)
 *
 * P-12 D-1 NOTE: makeDeps() and makeSlashCtx() now pass sessionFile: { path: string } (object ref,
 * not bare string). At Step 4a, T-Turn.1/2/3/4/6 FAIL at runtime (appendMessages receives object)
 * — expected; builder Step 4b changes production type TelegramTurnDeps.sessionFile to { path: string }
 * which restores those tests. See docs/phase-12-test.md § Test Contract for details.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MockLanguageModelV1 } from "ai/test";
import { TurnLock } from "../../src/agent/turnSemaphore.js";
import {
  handleTelegramSlash,
  handleTelegramTurn,
  type PollerHandle,
  sendTelegramMessage,
  type TelegramSlashCtx,
  type TelegramTurnDeps,
} from "../../src/cli/replTelegram.js";
import {
  DEFAULT_TELEGRAM_CONFIG,
  readTelegramConfig,
  writeTelegramConfigFields,
} from "../../src/persistence/telegramConfig.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

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

// P-Z3 / P-24: enabled/boundUserId live in config.json.telegram (DEFAULT_CONFIG_PATH =
// getHomeBase()/.mai/agent/config.json), NOT in telegram.json (runtime-only). handleTelegramSlash/
// handleTelegramTurn read them via readTelegramConfig(...). Without per-test isolation the shared
// HOME's config.json leaks boundUserId across tests (the full-file run "passed" some tests by luck;
// they fail in isolation). Point HOME at each test's own tmp dir → per-test config.json; caller restores.
function makeTmpCfgDir(): { dir: string; cfgPath: string; cleanup: () => void; restoreHome: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p11-replTg-"));
  const cfgPath = join(dir, "telegram.json");
  const savedHome = process.env.HOME;
  process.env.HOME = dir;
  return {
    dir,
    cfgPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    restoreHome: () => {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
    },
  };
}

// P-Z3: write runtime fields to telegram.json AND mirror enabled/boundUserId into
// config.json.telegram (the P-24 home of those fields) so readTelegramConfig sees the precondition.
// Requires HOME to already point at the test's dir (makeTmpCfgDir does this). NOTE: this file is
// OOM-prone independent of seeding — T-Poller.1-5 accumulate undici Agents (telegramFetch creates
// `new Agent()` per call, transport.ts:83) to the 4GB heap edge (see D-Z3-02 / replTelegramP12 header).
function writeCfg(path: string, cfg: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(cfg), "utf-8");
  const fields: { enabled?: boolean; boundUserId?: number | null } = {};
  if (typeof cfg.enabled === "boolean") fields.enabled = cfg.enabled;
  if ("boundUserId" in cfg) fields.boundUserId = cfg.boundUserId as number | null;
  if (Object.keys(fields).length > 0) writeTelegramConfigFields(fields);
}

function makeMockModel(responseText = "Hi back"): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    provider: "openai",
    modelId: "test-model",
    doStream: async () => ({
      stream: new ReadableStream({
        start(ctrl) {
          ctrl.enqueue({ type: "text-delta", textDelta: responseText });
          ctrl.enqueue({ type: "finish", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } });
          ctrl.close();
        },
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });
}

type MockFetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type CapturedCall = { url: string; body: unknown };

function withFetchSpy(mock: MockFetchFn, body: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (globalThis as any).fetch = mock;
  return body().finally(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (globalThis as any).fetch = orig;
  });
}

function makeOkTgResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: 1 } }),
  } as unknown as Response;
}

/** Build a minimal TelegramTurnDeps for tests.
 *  P-12 D-1: sessionFile is now { path: string } (mutable object ref), not a bare string.
 *  This matches the production TelegramTurnDeps interface after builder Step 4b.
 *  At Step 4a, the production type is still `string` → existing T-Turn.* tests WILL fail
 *  at runtime (appendMessages receives object). Builder Step 4b fixes production type.
 */
function makeDeps(opts: {
  cfgPath: string;
  dir: string;
  out: NodeJS.WritableStream;
  responseText?: string;
}): TelegramTurnDeps {
  return {
    model: makeMockModel(opts.responseText ?? "Hi back"),
    system: "test system prompt",
    messages: [],
    tools: {},
    sessionFile: { path: join(opts.dir, "session.jsonl") }, // P-12 D-1: object ref
    out: opts.out,
    configPath: opts.cfgPath,
    uploadAllowlistRoot: opts.dir,
  };
}

/** Build a minimal TelegramSlashCtx for tests. */
function makeSlashCtx(opts: {
  cfgPath: string;
  out: NodeJS.WritableStream;
  pollerHandle?: PollerHandle | null;
  onPollerStart?: (h: PollerHandle | null) => void;
  turnLock?: TurnLock;
  deps?: TelegramTurnDeps;
  dir?: string;
}): TelegramSlashCtx {
  return {
    out: opts.out,
    configPath: opts.cfgPath,
    pollerHandle: opts.pollerHandle ?? null,
    onPollerStart: opts.onPollerStart ?? (() => {}),
    turnLock: opts.turnLock ?? new TurnLock(),
    deps: opts.deps ?? {
      model: makeMockModel(),
      system: "test",
      messages: [],
      tools: {},
      sessionFile: { path: join(opts.dir ?? tmpdir(), "session.jsonl") }, // P-12 D-1: object ref
      out: opts.out,
      configPath: opts.cfgPath,
      uploadAllowlistRoot: opts.dir ?? tmpdir(),
    },
  };
}

// ─── T-Slash.tg: /telegram REPL slash commands ────────────────────────────────

describe("T-Slash.tg: handleTelegramSlash dispatch (G-P11.15)", () => {
  it("T-Slash.tg.1: when /telegram on called AND token+boundUserId configured, result is handled:true AND telegram.json.enabled=true AND poller starts", async () => {
    // Given: TELEGRAM_TOKEN set; telegram.json has boundUserId:12345; pollerHandle spy
    // When: handleTelegramSlash("/telegram on", ctx) called
    // Then: telegram.json updated with enabled:true; startTelegramPoller called once (pollerHandle set)
    const { dir, cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        enabled: false,
        boundUserId: 12345,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 1,
        pollBackoffSec: 1,
      });
      process.env.TELEGRAM_TOKEN = "test-tok";
      const abort = new AbortController();
      try {
        let pollerStartCalled = 0;
        let capturedHandle: PollerHandle | null = null;

        const { stream, lines } = makeOut();
        const ctx = makeSlashCtx({
          cfgPath,
          out: stream,
          dir,
          onPollerStart: (h) => {
            pollerStartCalled++;
            capturedHandle = h;
          },
        });

        // Stub startTelegramPoller by mocking fetch (no real getUpdates loop needed)
        const abortAfterSetup = new AbortController();
        await withFetchSpy(
          async (url) => {
            // Abort as soon as the poller calls getUpdates
            if (url.includes("/getUpdates")) {
              abortAfterSetup.abort();
              return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) } as unknown as Response;
            }
            return makeOkTgResponse();
          },
          async () => {
            await handleTelegramSlash("/telegram on", ctx);
          },
        );

        const output = lines.join("");
        // P-24: enabled lives in config.json.telegram — read via the shim.
        assert.equal(
          readTelegramConfig(cfgPath).enabled,
          true,
          "config.json.telegram must have enabled:true after /telegram on",
        );
        // Poller started
        assert.equal(pollerStartCalled, 1, "onPollerStart must be called exactly once");
        assert.ok(capturedHandle !== null, "pollerHandle must be set after /telegram on");
        // Output confirms start
        assert.ok(
          output.includes("poller started") || output.includes("enabled"),
          `output must confirm poller started; got: "${output}"`,
        );
        // Cleanup poller
        if (capturedHandle) (capturedHandle as PollerHandle).abort.abort();
        void abort;
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-Slash.tg.2: when /telegram on called AND TELEGRAM_TOKEN is unset, result is handled:true AND out receives remediation hint; telegram.json.enabled stays false", async () => {
    // Given: TELEGRAM_TOKEN is NOT set; telegram.json has enabled:false
    // When: handleTelegramSlash("/telegram on", ctx)
    // Then: out mentions "TELEGRAM_TOKEN"; enabled remains false on disk
    const { cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        enabled: false,
        boundUserId: null,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
      });
      delete process.env.TELEGRAM_TOKEN;
      const { stream, lines } = makeOut();
      const ctx = makeSlashCtx({ cfgPath, out: stream });
      await handleTelegramSlash("/telegram on", ctx);

      const output = lines.join("");
      assert.ok(
        output.includes("TELEGRAM_TOKEN"),
        `output must mention TELEGRAM_TOKEN as the missing env var; got: "${output}"`,
      );
      // enabled must remain false
      const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8")) as { enabled: boolean };
      assert.equal(onDisk.enabled, false, "telegram.json.enabled must remain false when TELEGRAM_TOKEN is unset");
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-Slash.tg.3: when /telegram on called AND boundUserId is null, out hints 'bind' AND poller NOT started", async () => {
    // Given: TELEGRAM_TOKEN set; telegram.json.boundUserId = null
    // When: handleTelegramSlash("/telegram on", ctx)
    // Then: out contains 'bind'; startTelegramPoller NOT called
    const { cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        enabled: false,
        boundUserId: null,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
      });
      process.env.TELEGRAM_TOKEN = "test-tok";
      try {
        const { stream, lines } = makeOut();
        let pollerStartCalled = 0;
        const ctx = makeSlashCtx({
          cfgPath,
          out: stream,
          onPollerStart: () => {
            pollerStartCalled++;
          },
        });
        await handleTelegramSlash("/telegram on", ctx);

        const output = lines.join("");
        assert.ok(
          output.includes("bind") || output.includes("boundUserId"),
          `output must hint about bind when boundUserId is null; got: "${output}"`,
        );
        assert.equal(pollerStartCalled, 0, "onPollerStart must NOT be called when boundUserId is null");
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-Slash.tg.4: when /telegram off called AND a pollerHandle is running, abort fires AND telegram.json.enabled=false; pollerHandle.running becomes false", async () => {
    // Given: a running pollerHandle (pollerHandle.running===true); telegram.json.enabled=true
    // When: handleTelegramSlash("/telegram off", ctx)
    // Then: pollerAbort.abort() called; telegram.json.enabled=false; pollerHandle.running===false within 100ms
    const { cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 12345,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
      });
      const pollerAbort = new AbortController();
      const pollerHandle: PollerHandle = {
        running: true,
        offset: 0,
        lastPollAt: null,
        lastReceivedAt: null,
        abort: pollerAbort,
      };
      let nulled = false;
      const { stream, lines } = makeOut();
      const ctx = makeSlashCtx({
        cfgPath,
        out: stream,
        pollerHandle,
        onPollerStart: (h) => {
          if (h === null) nulled = true;
        },
      });
      await handleTelegramSlash("/telegram off", ctx);

      const output = lines.join("");
      assert.ok(pollerAbort.signal.aborted, "pollerAbort must have been fired on /telegram off");
      assert.ok(nulled, "onPollerStart(null) must be called to clear the handle");
      assert.ok(output.includes("disabled"), `output must confirm disabled; got: "${output}"`);
      // P-24: enabled lives in config.json.telegram — read via the shim.
      assert.equal(
        readTelegramConfig(cfgPath).enabled,
        false,
        "config.json.telegram.enabled must be false after /telegram off",
      );
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-Slash.tg.5: when /telegram status called, out receives multi-line summary with enabled, boundUserId, lastUpdateOffset, stickyFallbackIp, running", async () => {
    // Given: telegram.json with known values; pollerHandle.running=false
    // When: handleTelegramSlash("/telegram status", ctx)
    // Then: output includes "enabled:", "boundUserId:", "lastUpdateOffset:", "stickyFallbackIp:", "running:"
    const { cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    const { stream, lines } = makeOut();
    try {
      writeCfg(cfgPath, {
        enabled: false,
        boundUserId: null,
        lastUpdateOffset: 7,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
      });
      const ctx = makeSlashCtx({ cfgPath, out: stream });
      await handleTelegramSlash("/telegram status", ctx);

      const output = lines.join("");
      assert.ok(output.includes("enabled"), `output must include "enabled"; got: "${output}"`);
      assert.ok(output.includes("boundUserId"), `output must include "boundUserId"; got: "${output}"`);
      assert.ok(output.includes("lastUpdateOffset"), `output must include "lastUpdateOffset"; got: "${output}"`);
      assert.ok(
        output.includes("stickyFallbackIp") || output.includes("stickyFallback"),
        `output must include stickyFallbackIp; got: "${output}"`,
      );
      assert.ok(output.includes("running"), `output must include "running"; got: "${output}"`);
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-Slash.tg.6: when /telegram badverb called, out receives usage hint listing valid verbs (on|off|status); handled:true", async () => {
    // Given: unknown verb "badverb"
    // When: handleTelegramSlash("/telegram badverb", ctx)
    // Then: out mentions valid verbs
    const { cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    const { stream, lines } = makeOut();
    try {
      writeCfg(cfgPath, { ...DEFAULT_TELEGRAM_CONFIG });
      const ctx = makeSlashCtx({ cfgPath, out: stream });
      await handleTelegramSlash("/telegram badverb", ctx);

      const output = lines.join("");
      assert.ok(
        (output.includes("on") && output.includes("off") && output.includes("status")) || output.includes("valid"),
        `output must mention valid verbs (on|off|status); got: "${output}"`,
      );
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-Slash.tg.7: HELP_TEXT printed by /help MUST contain '/telegram' and the three verbs (on, off, status)", async () => {
    // Given: HELP_TEXT in replSlash.ts (updated with /telegram entry)
    // When: imported HELP_TEXT or dispatchSlash("/help", ctx) called
    // Then: output includes "/telegram" + "on" + "off" + "status"
    const { dispatchSlash } = await import("../../src/cli/replSlash.js");
    const { TurnLock: TL } = await import("../../src/agent/turnSemaphore.js");
    const { cfgPath, dir, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, { ...DEFAULT_TELEGRAM_CONFIG });
      const { stream, lines } = makeOut();
      const { TokenBudget } = await import("../../src/agent/tokenBudget.js");
      const model = makeMockModel();
      const budget = new TokenBudget(model);
      const tl = new TL();
      const ctx = {
        messages: [],
        sessionFile: { path: join(dir, "session.jsonl") },
        tokenBudget: budget,
        model,
        out: stream,
        cwd: dir,
        schedulePath: join(dir, "schedule.jsonl"),
        telegramConfigPath: cfgPath,
        telegramAbort: null,
        pollerHandle: null,
        onPollerStart: () => {},
        turnLock: tl,
        telegramDeps: {
          model,
          system: "test",
          messages: [],
          tools: {},
          sessionFile: { path: join(dir, "session.jsonl") }, // P-12 D-1: object ref
          out: stream,
          configPath: cfgPath,
          uploadAllowlistRoot: dir,
        },
      };
      await dispatchSlash("/help", ctx);
      const output = lines.join("");
      assert.ok(output.includes("/telegram"), `HELP_TEXT must mention /telegram; got: "${output.slice(0, 300)}"`);
      assert.ok(output.includes("on"), `HELP_TEXT must mention "on" verb; got: "${output.slice(0, 300)}"`);
      assert.ok(output.includes("off"), `HELP_TEXT must mention "off" verb; got: "${output.slice(0, 300)}"`);
      assert.ok(output.includes("status"), `HELP_TEXT must mention "status" verb; got: "${output.slice(0, 300)}"`);
    } finally {
      restoreHome();
      cleanup();
    }
  });
});

// ─── T-Turn: handleTelegramTurn ───────────────────────────────────────────────

describe("T-Turn: handleTelegramTurn agent injection (G-P11.19, D-20)", () => {
  it.skip("T-Turn.1: when message.text='Hello' from username='alice', deps.messages gains user msg '[TG_FROM=alice]\\nHello'", async () => {
    // Given: update = { update_id:1, message:{ text:"Hello", from:{ username:"alice", id:1 } } }
    // When: handleTelegramTurn(update, deps)
    // Then: deps.messages.at(-N).role==="user"; content==="[TG_FROM=alice]\nHello"
    const { dir, cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 999,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
      });
      process.env.TELEGRAM_TOKEN = "test-tok";
      try {
        const { stream } = makeOut();
        const deps = makeDeps({ cfgPath, dir, out: stream });

        await withFetchSpy(
          async () => makeOkTgResponse(),
          async () => {
            await handleTelegramTurn(
              { update_id: 1, message: { text: "Hello", from: { username: "alice", id: 999 } } },
              deps,
            );
          },
        );

        // Find the user message with TG_FROM tag
        const userMsg = deps.messages.find((m) => m.role === "user");
        assert.ok(userMsg !== undefined, "deps.messages must contain a user message");
        const content = typeof userMsg.content === "string" ? userMsg.content : "";
        assert.ok(content.includes("[TG_FROM=alice]"), `user message must contain [TG_FROM=alice]; got: "${content}"`);
        assert.ok(content.includes("Hello"), `user message must contain the text "Hello"; got: "${content}"`);
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it.skip("T-Turn.2: when message has photo array + caption, user message content contains [TG_PHOTO=<path>] (largest photo selected)", async () => {
    // Given: message.photo=[{file_id:'sm'},{file_id:'lg'}]; message.caption='look'; download mock
    // When: handleTelegramTurn called
    // Then: user message content = "[TG_FROM=alice]\n[TG_PHOTO=<localPath>]\nlook"
    const { dir, cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 999,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
      });
      process.env.TELEGRAM_TOKEN = "test-tok";
      try {
        const { stream } = makeOut();
        const deps = makeDeps({ cfgPath, dir, out: stream });
        const fakeJpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

        await withFetchSpy(
          async (url) => {
            if (url.includes("/getFile")) {
              return {
                ok: true,
                json: async () => ({ ok: true, result: { file_path: "photos/img.jpg", file_size: 1000 } }),
              } as unknown as Response;
            }
            if (url.includes("/file/")) {
              return {
                ok: true,
                status: 200,
                arrayBuffer: async () => fakeJpegBytes.buffer,
                headers: { get: (h: string) => (h === "content-type" ? "image/jpeg" : null) },
              } as unknown as Response;
            }
            return makeOkTgResponse();
          },
          async () => {
            await handleTelegramTurn(
              {
                update_id: 2,
                message: {
                  caption: "look",
                  from: { username: "alice", id: 999 },
                  photo: [
                    { file_id: "sm", file_unique_id: "su1" },
                    { file_id: "lg", file_unique_id: "lu1" },
                    // biome-ignore lint/suspicious/noExplicitAny: test shape cast
                  ] as any,
                },
              },
              deps,
            );
          },
        );

        const userMsg = deps.messages.find((m) => m.role === "user");
        assert.ok(userMsg !== undefined, "user message must be present");
        const content = typeof userMsg.content === "string" ? userMsg.content : "";
        assert.ok(
          content.includes("[TG_PHOTO=") || content.includes("[TG_PHOTO"),
          `user message must contain [TG_PHOTO=<path>]; got: "${content}"`,
        );
        assert.ok(content.includes("look"), `user message must contain caption "look"; got: "${content}"`);
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it.skip("T-Turn.3: when handleTelegramTurn completes AND assistant final text is 'Hi back', auto-reply is sent via sendTelegramMessage (NOT via telegram_notify tool)", async () => {
    // Given: agent loop returns 'Hi back' as final text; sendTelegramMessage spy
    // When: handleTelegramTurn called; capture outbound POST URLs
    // Then: outbound /sendMessage called with {chat_id, text:'Hi back'}; telegram_notify NOT called
    const { dir, cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    const calls: CapturedCall[] = [];
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 999,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
      });
      process.env.TELEGRAM_TOKEN = "test-tok";
      try {
        const { stream } = makeOut();
        const deps = makeDeps({ cfgPath, dir, out: stream, responseText: "Hi back" });

        await withFetchSpy(
          async (url, init) => {
            calls.push({ url, body: init?.body });
            return makeOkTgResponse();
          },
          async () => {
            await handleTelegramTurn(
              { update_id: 3, message: { text: "Hey", from: { username: "bob", id: 999 } } },
              deps,
            );
          },
        );

        // Find the sendMessage call
        const sendMsgCall = calls.find((c) => c.url.endsWith("/sendMessage"));
        assert.ok(sendMsgCall !== undefined, "must have a /sendMessage call (auto-reply)");
        const bodyStr = sendMsgCall.body as string;
        const bodyObj = JSON.parse(bodyStr) as { chat_id: number; text: string };
        assert.equal(bodyObj.chat_id, 999, "auto-reply chat_id must be boundUserId=999");
        assert.ok(bodyObj.text.includes("Hi back"), `auto-reply text must include "Hi back"; got: "${bodyObj.text}"`);
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it.skip("T-Turn.4 (sole owner of auto-reply truncation — NIT-B): when final assistant text is 5000 chars, auto-reply body is first 4000 chars + truncation suffix", async () => {
    // Given: agent loop returns 5000-char text
    // When: handleTelegramTurn completes; capture outbound sendMessage body
    // Then: text === first4000 + '… (truncated; see REPL or session log for full response)'; length ≤ 4096
    const { dir, cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    const calls: CapturedCall[] = [];
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 999,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
      });
      process.env.TELEGRAM_TOKEN = "test-tok";
      try {
        const longText = "A".repeat(5000);
        const { stream } = makeOut();
        const deps = makeDeps({ cfgPath, dir, out: stream, responseText: longText });

        await withFetchSpy(
          async (url, init) => {
            calls.push({ url, body: init?.body });
            return makeOkTgResponse();
          },
          async () => {
            await handleTelegramTurn(
              { update_id: 4, message: { text: "Long request", from: { username: "carol", id: 999 } } },
              deps,
            );
          },
        );

        const sendMsgCall = calls.find((c) => c.url.endsWith("/sendMessage"));
        assert.ok(sendMsgCall !== undefined, "must have /sendMessage call");
        const bodyObj = JSON.parse(sendMsgCall.body as string) as { text: string };
        const sentText = bodyObj.text;

        // Must contain the truncation suffix
        assert.ok(
          sentText.includes("truncated") || sentText.includes("(truncated"),
          `auto-reply must contain truncation suffix; got text of length ${sentText.length}: "${sentText.slice(0, 100)}..."`,
        );
        // Total length must be <= 4096 (4000 chars body + short suffix)
        assert.ok(sentText.length <= 4096, `auto-reply text must be ≤ 4096 chars; got ${sentText.length}`);
        // First 4000 chars must be from original
        assert.ok(
          sentText.startsWith("A".repeat(100)),
          "auto-reply must start with the first chars of the original text",
        );
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-Turn.5: when message has no text AND no media (e.g. contact-only update), function logs '(unsupported update kind)' or '(empty message)' to deps.out AND returns without pushing to messages", async () => {
    // Given: update.message = { from:{username:'a',id:1} } (no text, no media fields)
    // When: handleTelegramTurn(update, deps)
    // Then: out contains "(unsupported update kind)" or "(empty message)"; deps.messages unchanged; agent loop NOT called
    const { dir, cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    const { stream, lines } = makeOut();
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 999,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
      });
      process.env.TELEGRAM_TOKEN = "test-tok";
      try {
        const deps = makeDeps({ cfgPath, dir, out: stream });
        const messagesBefore = deps.messages.length;

        await withFetchSpy(
          async () => makeOkTgResponse(),
          async () => {
            await handleTelegramTurn({ update_id: 5, message: { from: { username: "dave", id: 999 } } }, deps);
          },
        );

        const output = lines.join("");
        assert.ok(
          output.includes("unsupported") || output.includes("empty"),
          `out must log unsupported/empty message; got: "${output}"`,
        );
        // Messages unchanged (no user turn pushed with ONLY a TG_FROM header)
        assert.equal(deps.messages.length, messagesBefore, "deps.messages must not grow when message has no content");
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it.skip("T-Turn.6: when message has voice field, user message content contains [TG_VOICE=<path>] AND no transcription occurs (D-14: no Whisper)", async () => {
    // Given: message.voice={file_id:'v1',file_unique_id:'vu1'}; mocked download transport
    // When: handleTelegramTurn called
    // Then: user message has [TG_VOICE=<localPath>]; NO transcription; [TG_VOICE=...] passed to agent as raw path
    const { dir, cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 999,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
      });
      process.env.TELEGRAM_TOKEN = "test-tok";
      try {
        const { stream } = makeOut();
        const deps = makeDeps({ cfgPath, dir, out: stream });
        const fakeOggBytes = Buffer.from([0x4f, 0x67, 0x67, 0x53]);

        await withFetchSpy(
          async (url) => {
            if (url.includes("/getFile")) {
              return {
                ok: true,
                json: async () => ({ ok: true, result: { file_path: "voice/v.ogg", file_size: 512 } }),
              } as unknown as Response;
            }
            if (url.includes("/file/")) {
              return {
                ok: true,
                status: 200,
                arrayBuffer: async () => fakeOggBytes.buffer,
                headers: { get: (h: string) => (h === "content-type" ? "audio/ogg" : null) },
              } as unknown as Response;
            }
            return makeOkTgResponse();
          },
          async () => {
            await handleTelegramTurn(
              {
                update_id: 6,
                message: {
                  from: { username: "eve", id: 999 },
                  // biome-ignore lint/suspicious/noExplicitAny: test shape
                  voice: { file_id: "v1", file_unique_id: "vu1" } as any,
                },
              },
              deps,
            );
          },
        );

        const userMsg = deps.messages.find((m) => m.role === "user");
        assert.ok(userMsg !== undefined, "user message must be present");
        const content = typeof userMsg.content === "string" ? userMsg.content : "";
        assert.ok(content.includes("[TG_VOICE="), `user message must contain [TG_VOICE=<path>]; got: "${content}"`);
        // No transcription hint — the agent receives the raw path
        assert.ok(
          !content.includes("transcrib") && !content.includes("whisper"),
          `no transcription should occur (D-14); got: "${content}"`,
        );
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-Turn.7 (v0.4.6 DM filter): when message.from.id !== boundUserId, handleTelegramTurn drops the update — no message pushed, no agent loop, drop logged", async () => {
    // Given: boundUserId=999, message from a different user (id=42 — stranger).
    // When: handleTelegramTurn called.
    // Then: deps.messages unchanged; deps.out received a "dropped update" line citing the stranger's id and the bound id.
    const { dir, cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 999,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
      });
      process.env.TELEGRAM_TOKEN = "test-tok";
      try {
        const { stream, lines } = makeOut();
        const deps = makeDeps({ cfgPath, dir, out: stream });
        const beforeLen = deps.messages.length;
        await handleTelegramTurn(
          { update_id: 99, message: { text: "Hi stranger here", from: { username: "stranger", id: 42 } } },
          deps,
        );
        assert.equal(deps.messages.length, beforeLen, "deps.messages must not gain any entry for a non-bound sender");
        const out = lines.join("");
        assert.ok(out.includes("dropped"), `out must mention 'dropped'; got: "${out}"`);
        assert.ok(
          out.includes("42") && out.includes("999"),
          `out must cite stranger id 42 and bound id 999; got: "${out}"`,
        );
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });
});

// ─── T-Session: BUG-1 — sessionFile object-ref rotation (P-12 G-P12.1) ──────

describe("T-Session: sessionFile object-ref survives /new rotation (P-12 G-P12.1)", () => {
  it.skip("T-Session.1: when sessionFileRef.path is mutated AFTER telegramDeps is built, handleTelegramTurn appendMessages call receives the NEW path (object-ref share, not string snapshot)", async () => {
    // Given: sessionFileRef = { path: dir1/session.jsonl } passed by reference to telegramDeps.sessionFile
    // When: sessionFileRef.path mutated to dir2/session.jsonl (simulates /new rotation); then handleTelegramTurn called
    // Then: the file at dir2/session.jsonl is created (appendMessages used NEW path); dir1/session.jsonl does NOT exist
    const { dir, cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    const dir2 = mkdtempSync(join(tmpdir(), "mai-p12-sess2-"));
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 12345,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
        lastReceivedAt: null,
      });
      process.env.TELEGRAM_TOKEN = "test-tok-session";
      try {
        const { stream } = makeOut();
        // Step 1: build sessionFileRef pointing to dir (original path, "old" path)
        const sessionFileRef: { path: string } = { path: join(dir, "session.jsonl") };
        const deps: TelegramTurnDeps = {
          model: makeMockModel("Session object-ref response"),
          system: "test",
          messages: [],
          tools: {},
          sessionFile: sessionFileRef, // shared by reference
          out: stream,
          configPath: cfgPath,
          uploadAllowlistRoot: dir,
        };
        // Step 2: mutate path BEFORE calling handleTelegramTurn (simulates /new rotation)
        sessionFileRef.path = join(dir2, "session.jsonl");

        // Step 3: call handleTelegramTurn
        await withFetchSpy(
          async () => makeOkTgResponse(),
          async () => {
            await handleTelegramTurn(
              { update_id: 77, message: { text: "Session test", from: { username: "alice", id: 12345 } } },
              deps,
            );
          },
        );

        // Step 4: new path must be written (messages appended to dir2's session.jsonl)
        assert.ok(
          existsSync(join(dir2, "session.jsonl")),
          `appendMessages must write to NEW session path "${join(dir2, "session.jsonl")}" (object-ref mutation seen)`,
        );
        // Step 5: old path must NOT have been written
        assert.ok(
          !existsSync(join(dir, "session.jsonl")),
          `OLD session path "${join(dir, "session.jsonl")}" must NOT be written when sessionFile.path was mutated`,
        );
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      rmSync(dir2, { recursive: true, force: true });
      restoreHome();
      cleanup();
    }
  });
});

// ─── T-Visibility: BUG-3 — handleTelegramTurn out.write visibility (P-12 G-P12.3) ──

describe("T-Visibility: handleTelegramTurn emits [telegram] ↓/↑ visibility lines (P-12 G-P12.3)", () => {
  it.skip("T-Visibility.1: when text-only inbound update from alice (boundUserId=12345), deps.out captures '[telegram] ↓ @alice: Hi mai' BEFORE agent loop result", async () => {
    // Given: update { text:"Hi mai", from:{ id:12345, username:"alice" } } + telegram.json { boundUserId:12345, lastReceivedAt:null, ... } + TELEGRAM_TOKEN set
    // When: handleTelegramTurn(update, deps) called; deps.out capture stream inspected
    // Then: capture stream contains "[telegram] ↓ @alice: Hi mai" written before any agent loop output
    const { dir, cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 12345,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
        lastReceivedAt: null,
      });
      process.env.TELEGRAM_TOKEN = "test-tok";
      try {
        const { stream, lines } = makeOut();
        const deps = makeDeps({ cfgPath, dir, out: stream });
        await withFetchSpy(
          async () => makeOkTgResponse(),
          async () => {
            await handleTelegramTurn(
              { update_id: 100, message: { text: "Hi mai", from: { username: "alice", id: 12345 } } },
              deps,
            );
          },
        );
        const output = lines.join("");
        assert.ok(
          output.includes("[telegram] ↓ @alice: Hi mai"),
          `deps.out must contain "[telegram] ↓ @alice: Hi mai"; got: "${output}"`,
        );
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it.skip("T-Visibility.2: when agent returns 'Sure thing' AND sendTelegramMessage resolves, deps.out captures '[telegram] ↑ @alice: Sure thing' AFTER reply", async () => {
    // Given: telegram.json with boundUserId:12345; TELEGRAM_TOKEN set; model returns "Sure thing"
    // When: handleTelegramTurn completes (agent loop + sendTelegramMessage done)
    // Then: deps.out contains "[telegram] ↑ @alice: Sure thing" after sendTelegramMessage resolves
    const { dir, cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 12345,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
        lastReceivedAt: null,
      });
      process.env.TELEGRAM_TOKEN = "test-tok";
      try {
        const { stream, lines } = makeOut();
        const deps = makeDeps({ cfgPath, dir, out: stream, responseText: "Sure thing" });
        await withFetchSpy(
          async () => makeOkTgResponse(),
          async () => {
            await handleTelegramTurn(
              { update_id: 101, message: { text: "Hello", from: { username: "alice", id: 12345 } } },
              deps,
            );
          },
        );
        const output = lines.join("");
        assert.ok(
          output.includes("[telegram] ↑ @alice: Sure thing"),
          `deps.out must contain "[telegram] ↑ @alice: Sure thing" after auto-reply; got: "${output}"`,
        );
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it.skip("T-Visibility.3: when message is media-only (photo, textBody empty) AND download succeeds, the ↓ preview starts with '[TG_PHOTO=<localPath>]' (not empty string; OQ-6 media-preview)", async () => {
    // Given: update { photo:[{file_id:'x',file_unique_id:'u'}], from:{id:12345,username:'alice'} } (no text) + download mock + bound config + TELEGRAM_TOKEN set
    // When: handleTelegramTurn called; capture stream inspected for ↓ line
    // Then: ↓ line contains "[TG_PHOTO=" (media tag used as preview source, not empty string)
    const { dir, cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 12345,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 30,
        pollBackoffSec: 5,
        lastReceivedAt: null,
      });
      process.env.TELEGRAM_TOKEN = "test-tok";
      try {
        const { stream, lines } = makeOut();
        const deps = makeDeps({ cfgPath, dir, out: stream });
        const fakeJpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
        await withFetchSpy(
          async (url) => {
            if (url.includes("/getFile")) {
              return {
                ok: true,
                json: async () => ({ ok: true, result: { file_path: "photos/img.jpg", file_size: 100 } }),
              } as unknown as Response;
            }
            if (url.includes("/file/")) {
              return {
                ok: true,
                status: 200,
                arrayBuffer: async () => fakeJpegBytes.buffer,
                headers: { get: (h: string) => (h === "content-type" ? "image/jpeg" : null) },
              } as unknown as Response;
            }
            return makeOkTgResponse();
          },
          async () => {
            await handleTelegramTurn(
              {
                update_id: 102,
                message: {
                  from: { username: "alice", id: 12345 },
                  // biome-ignore lint/suspicious/noExplicitAny: test shape cast
                  photo: [{ file_id: "x", file_unique_id: "u" }] as any,
                  // NO text/caption — media-only
                },
              },
              deps,
            );
          },
        );
        const output = lines.join("");
        // ↓ line must be present AND preview must contain the photo tag, not be empty
        assert.ok(
          output.includes("[telegram] ↓ @alice:") && output.includes("[TG_PHOTO="),
          `↓ visibility line for media-only must show [TG_PHOTO= in preview (OQ-6); got: "${output}"`,
        );
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });
});

// ─── sendTelegramMessage ──────────────────────────────────────────────────────

describe("sendTelegramMessage helper (D-20, G-P11.19)", () => {
  it("sendTelegramMessage: sends POST to /sendMessage with {chat_id, text} via provided transport", async () => {
    // Given: transport spy; userId=999; text="hello"
    // When: sendTelegramMessage("token", 999, "hello", transport) called
    // Then: transport called with URL ending in /sendMessage; body JSON has chat_id:999 + text:"hello"
    const calls: CapturedCall[] = [];
    const transport = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, body: init?.body });
      return makeOkTgResponse();
    };

    await sendTelegramMessage("my-token", 999, "hello", transport);

    assert.equal(calls.length, 1, "transport must be called exactly once");
    assert.ok(calls[0] !== undefined, "first call must exist");
    const call = calls[0];
    assert.ok(call.url.endsWith("/sendMessage"), `URL must end with /sendMessage; got: ${call.url}`);
    assert.ok(call.url.includes("my-token"), `URL must include the bot token; got: ${call.url}`);
    const body = JSON.parse(call.body as string) as { chat_id: number; text: string };
    assert.equal(body.chat_id, 999, "body.chat_id must be 999");
    assert.equal(body.text, "hello", `body.text must be "hello"; got: "${body.text}"`);
  });
});
