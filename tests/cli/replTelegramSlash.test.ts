/** Extracted Telegram slash-command and outbound-helper coverage (G-P11.15/G-P11.19). */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MockLanguageModelV1 } from "ai/test";
import { TurnLock } from "../../src/agent/turnSemaphore.js";
import {
  handleTelegramSlash,
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
import { cleanupTmpDir } from "../_helpers/tmp";
import { unexpectedTelegramRoute, waitForPollerStopped } from "./_helpers/telegramTest.js";

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
    cleanup: () => cleanupTmpDir(dir),
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

        // Keep the route fake installed until the real poller has drained.
        await withFetchSpy(
          async (url) => {
            if (url.includes("/getUpdates")) {
              return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) } as unknown as Response;
            }
            return unexpectedTelegramRoute(url);
          },
          async () => {
            await handleTelegramSlash("/telegram on", ctx);
            assert.ok(capturedHandle !== null, "pollerHandle must be set after /telegram on");
            capturedHandle.abort.abort();
            await waitForPollerStopped(capturedHandle, "T-Slash.tg.1 poller");
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
        // Output confirms start
        assert.ok(
          output.includes("poller started") || output.includes("enabled"),
          `output must confirm poller started; got: "${output}"`,
        );
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

  it("T-Slash.tg.4: when /telegram off called AND a pollerHandle is attached, abort fires AND telegram.json.enabled=false AND the handle is detached", async () => {
    // Given: a running pollerHandle (pollerHandle.running===true); telegram.json.enabled=true
    // When: handleTelegramSlash("/telegram off", ctx)
    // Then: pollerAbort.abort() called; telegram.json.enabled=false; onPollerStart(null) detaches the handle
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
