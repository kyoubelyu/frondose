/**
 * P-12 Step 5 validation harness — T-Poller.6, T-Session.1, T-Visibility.1..3
 *
 * These tests live "officially" in replTelegram.test.ts but cannot be run in
 * isolation there because T-Poller.1..5 (which precede them) accumulate ~10+
 * undici Agent() instances that hit V8's ~4GB heap limit on this machine.
 *
 * This standalone file runs only the NEW P-12 tests in a fresh process with
 * minimal heap pressure. Gate coverage: G-P12.1, G-P12.3, G-P12.4.
 *
 * Used for Step 5 smoke verification; the canonical copies remain in
 * replTelegram.test.ts which runs via `npm test` under child-process isolation.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { MockLanguageModelV1 } from "ai/test";
import { TurnLock } from "../../src/agent/turnSemaphore.js";
import {
  handleTelegramTurn,
  type PollerHandle,
  startTelegramPoller,
  type TelegramTurnDeps,
} from "../../src/cli/replTelegram.js";
import { writeTelegramConfigFields } from "../../src/persistence/telegramConfig.js";
import { cleanupTmpDir } from "../_helpers/tmp";
import { appendAssistant, createPiLoopMock } from "./_helpers/piLoopMock.js";
import { unexpectedTelegramRoute, waitForPollerStopped } from "./_helpers/telegramTest.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

const piLoop = createPiLoopMock();
before(() => piLoop.install());
beforeEach(() => piLoop.reset());
after(() => piLoop.restore());

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
// getHomeBase()/.mai/agent/config.json), NOT in telegram.json. handleTelegramTurn reads boundUserId
// via readTelegramConfig (the auto-reply ↑ line requires it). Point HOME at the test's tmp dir →
// per-test config.json; caller restores.
function makeTmpCfgDir(): { dir: string; cfgPath: string; cleanup: () => void; restoreHome: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p12-new-"));
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
// config.json.telegram so readTelegramConfig sees the precondition. Requires HOME already set.
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

function makeGetUpdatesResponse(
  updates: Array<{ update_id: number; message?: { text?: string; from?: { username?: string; id: number } } }>,
): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: updates }),
  } as unknown as Response;
}

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
    sessionFile: { path: join(opts.dir, "session.jsonl") },
    out: opts.out,
    configPath: opts.cfgPath,
    uploadAllowlistRoot: opts.dir,
  };
}

// ─── T-Poller.6: PollerHandle.lastReceivedAt (P-12 D-5 NIT-1) ────────────────

describe("T-Poller.6: startTelegramPoller lastReceivedAt (G-P12.4)", () => {
  it("T-Poller.6: when startTelegramPoller processes one update, PollerHandle.lastReceivedAt advances from null to an ISO timestamp AND mirrors to telegram.json", async () => {
    // Given: startTelegramPoller called with 1-update mock; handle.lastReceivedAt initially null
    // When: poller processes the update; second poll → abort; timeout after 600ms
    // Then: handle.lastReceivedAt is ISO timestamp; telegram.json.lastReceivedAt matches
    const { dir, cfgPath, cleanup, restoreHome } = makeTmpCfgDir();
    try {
      writeCfg(cfgPath, {
        enabled: true,
        boundUserId: 999,
        lastUpdateOffset: 0,
        stickyFallbackIp: null,
        pollTimeoutSec: 1,
        pollBackoffSec: 1,
        lastReceivedAt: null,
      });
      process.env.TELEGRAM_TOKEN = "test-tok";
      try {
        const abort = new AbortController();
        const turnLock = new TurnLock();
        const { stream } = makeOut();
        const deps = makeDeps({ cfgPath, dir, out: stream });
        let pollCount = 0;
        let capturedHandle: PollerHandle | null = null;
        piLoop.queue(async (opts) => appendAssistant(opts, "Hi back"));

        await withFetchSpy(
          async (url) => {
            if (url.includes("/getUpdates")) {
              pollCount++;
              if (pollCount === 1) {
                return makeGetUpdatesResponse([
                  { update_id: 20, message: { text: "hello", from: { username: "u", id: 999 } } },
                ]);
              }
              abort.abort();
              return makeGetUpdatesResponse([]);
            }
            if (url.endsWith("/sendMessage")) return makeOkTgResponse();
            return unexpectedTelegramRoute(url);
          },
          async () => {
            capturedHandle = await startTelegramPoller(
              {
                enabled: true,
                boundUserId: 999,
                lastUpdateOffset: 0,
                stickyFallbackIp: null,
                pollTimeoutSec: 1,
                pollBackoffSec: 1,
                lastReceivedAt: null,
              },
              deps,
              turnLock,
              abort,
            );
            await waitForPollerStopped(capturedHandle, "T-Poller.6");
          },
        );
        piLoop.assertDrained(1);

        assert.ok(capturedHandle !== null, "startTelegramPoller must return a PollerHandle");
        const handle = capturedHandle as PollerHandle;
        assert.notEqual(handle.lastReceivedAt, null, "handle.lastReceivedAt must advance from null");
        assert.ok(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(handle.lastReceivedAt ?? ""),
          `handle.lastReceivedAt must be ISO; got: "${handle.lastReceivedAt}"`,
        );
        const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8")) as { lastReceivedAt: string | null };
        assert.notEqual(onDisk.lastReceivedAt, null, "telegram.json.lastReceivedAt must be non-null");
        assert.equal(
          onDisk.lastReceivedAt,
          handle.lastReceivedAt,
          "telegram.json.lastReceivedAt must match PollerHandle.lastReceivedAt",
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

// ─── T-Session.1: sessionFile object-ref survives /new rotation ──────────────

describe("T-Session.1: sessionFile object-ref rotation (G-P12.1)", () => {
  it("T-Session.1: when sessionFileRef.path is mutated AFTER telegramDeps is built, appendMessages uses NEW path", async () => {
    // Given: sessionFileRef = { path: dir1/session.jsonl } passed by reference
    // When: path mutated to dir2/session.jsonl before handleTelegramTurn call
    // Then: dir2/session.jsonl created; dir1/session.jsonl does NOT exist
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
        const sessionFileRef: { path: string } = { path: join(dir, "session.jsonl") };
        const deps: TelegramTurnDeps = {
          model: makeMockModel("Session object-ref response"),
          system: "test",
          messages: [],
          tools: {},
          sessionFile: sessionFileRef,
          out: stream,
          configPath: cfgPath,
          uploadAllowlistRoot: dir,
        };
        // Mutate path BEFORE call (simulates /new rotation)
        sessionFileRef.path = join(dir2, "session.jsonl");
        piLoop.queue(async (opts) => appendAssistant(opts, "Session object-ref response"));

        await withFetchSpy(
          async (url) => {
            if (url.endsWith("/sendMessage")) return makeOkTgResponse();
            return unexpectedTelegramRoute(url);
          },
          async () => {
            await handleTelegramTurn(
              { update_id: 77, message: { text: "Session test", from: { username: "alice", id: 12345 } } },
              deps,
            );
          },
        );
        piLoop.assertDrained(1);

        assert.ok(
          existsSync(join(dir2, "session.jsonl")),
          `appendMessages must write to NEW path (${join(dir2, "session.jsonl")})`,
        );
        assert.ok(
          !existsSync(join(dir, "session.jsonl")),
          `OLD path (${join(dir, "session.jsonl")}) must NOT be written`,
        );
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      cleanupTmpDir(dir2);
      restoreHome();
      cleanup();
    }
  });
});

// ─── T-Visibility.1/2/3: [telegram] ↓/↑ visibility lines ────────────────────

describe("T-Visibility: handleTelegramTurn visibility lines (G-P12.3)", () => {
  it("T-Visibility.1: text-only inbound from alice → deps.out contains '[telegram] ↓ @alice: Hi mai'", async () => {
    // Given: boundUserId:12345, update from alice (id:12345), text "Hi mai"
    // When: handleTelegramTurn called
    // Then: deps.out contains "[telegram] ↓ @alice: Hi mai"
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
        piLoop.queue(async (opts) => {
          assert.ok(lines.join("").includes("[telegram] ↓ @alice: Hi mai"));
          appendAssistant(opts, "Hi back");
        });
        await withFetchSpy(
          async (url) => {
            if (url.endsWith("/sendMessage")) return makeOkTgResponse();
            return unexpectedTelegramRoute(url);
          },
          async () => {
            await handleTelegramTurn(
              { update_id: 100, message: { text: "Hi mai", from: { username: "alice", id: 12345 } } },
              deps,
            );
          },
        );
        piLoop.assertDrained(1);
        const output = lines.join("");
        assert.ok(
          output.includes("[telegram] ↓ @alice: Hi mai"),
          `out must contain "[telegram] ↓ @alice: Hi mai"; got: "${output}"`,
        );
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-Visibility.2: agent returns 'Sure thing' → deps.out contains '[telegram] ↑ @alice: Sure thing'", async () => {
    // Given: boundUserId:12345, model returns "Sure thing"
    // When: handleTelegramTurn completes (agent loop + sendTelegramMessage done)
    // Then: deps.out contains "[telegram] ↑ @alice: Sure thing"
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
        piLoop.queue(async (opts) => appendAssistant(opts, "Sure thing"));
        await withFetchSpy(
          async (url) => {
            if (url.endsWith("/sendMessage")) return makeOkTgResponse();
            return unexpectedTelegramRoute(url);
          },
          async () => {
            await handleTelegramTurn(
              { update_id: 101, message: { text: "Hello", from: { username: "alice", id: 12345 } } },
              deps,
            );
          },
        );
        piLoop.assertDrained(1);
        const output = lines.join("");
        assert.ok(
          output.includes("[telegram] ↑ @alice: Sure thing"),
          `out must contain "[telegram] ↑ @alice: Sure thing"; got: "${output}"`,
        );
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-Visibility.3: photo-only inbound → ↓ line preview contains '[TG_PHOTO='", async () => {
    // Given: photo-only update (no text), download mock, boundUserId:12345
    // When: handleTelegramTurn called
    // Then: ↓ line preview contains "[TG_PHOTO=" (media tag used as preview, not empty)
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
        piLoop.queue(async (opts) => appendAssistant(opts, "Hi back"));
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
            if (url.endsWith("/sendMessage")) return makeOkTgResponse();
            return unexpectedTelegramRoute(url);
          },
          async () => {
            await handleTelegramTurn(
              {
                update_id: 102,
                message: {
                  from: { username: "alice", id: 12345 },
                  // biome-ignore lint/suspicious/noExplicitAny: test shape
                  photo: [{ file_id: "x", file_unique_id: "u" }] as any,
                },
              },
              deps,
            );
          },
        );
        piLoop.assertDrained(1);
        const output = lines.join("");
        assert.ok(
          output.includes("[telegram] ↓ @alice:") && output.includes("[TG_PHOTO="),
          `↓ line for media-only must show [TG_PHOTO= preview; got: "${output}"`,
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
