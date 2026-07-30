/** Telegram turn, session-rotation, and visibility behavior (G-P11.19/G-P12.1/G-P12.3). */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { MockLanguageModelV1 } from "ai/test";
import { handleTelegramTurn, type TelegramTurnDeps } from "../../src/cli/replTelegram.js";
import { writeTelegramConfigFields } from "../../src/persistence/telegramConfig.js";
import { cleanupTmpDir } from "../_helpers/tmp";
import { appendAssistant, createPiLoopMock } from "./_helpers/piLoopMock.js";
import { deferred, unexpectedTelegramRoute } from "./_helpers/telegramTest.js";

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

/** Build a minimal dependency set with the current mutable session-file reference. */
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

// ─── T-Turn: handleTelegramTurn ───────────────────────────────────────────────

describe("T-Turn: handleTelegramTurn agent injection (G-P11.19, D-20)", () => {
  it("T-Turn.1: when message.text='Hello' from username='alice', deps.messages gains user msg '[TG_FROM=alice]\\nHello'", async () => {
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
        piLoop.queue(async (opts) => appendAssistant(opts, "Hi back"));

        await withFetchSpy(
          async (url) => {
            if (url.endsWith("/sendMessage")) return makeOkTgResponse();
            return unexpectedTelegramRoute(url);
          },
          async () => {
            await handleTelegramTurn(
              { update_id: 1, message: { text: "Hello", from: { username: "alice", id: 999 } } },
              deps,
            );
          },
        );
        piLoop.assertDrained(1);

        const userMessages = deps.messages.filter((message) => message.role === "user");
        assert.equal(userMessages.length, 1, "the turn must append exactly one user message");
        assert.equal(userMessages[0]?.content, "[TG_FROM=alice]\nHello");
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-Turn.2: when message has photo array + caption, user message content contains [TG_PHOTO=<path>] (largest photo selected)", async () => {
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
        const requestedFileIds: string[] = [];
        piLoop.queue(async (opts) => appendAssistant(opts, "Hi back"));

        await withFetchSpy(
          async (url, init) => {
            if (url.includes("/getFile")) {
              const body = JSON.parse(String(init?.body)) as { file_id: string };
              requestedFileIds.push(body.file_id);
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
            if (url.endsWith("/sendMessage")) return makeOkTgResponse();
            return unexpectedTelegramRoute(url);
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
        piLoop.assertDrained(1);
        assert.deepEqual(requestedFileIds, ["lg"], "Telegram photo selection must request only the largest entry");

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

  it("T-Turn.3: when handleTelegramTurn completes AND assistant final text is 'Hi back', auto-reply is sent via sendTelegramMessage (NOT via telegram_notify tool)", async () => {
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
        assert.equal(Object.hasOwn(deps.tools, "telegram_notify"), false, "telegram_notify must not be in turn tools");
        piLoop.queue(async (opts) => appendAssistant(opts, "Hi back"));

        await withFetchSpy(
          async (url, init) => {
            if (url.endsWith("/sendMessage")) {
              calls.push({ url, body: init?.body });
              return makeOkTgResponse();
            }
            return unexpectedTelegramRoute(url);
          },
          async () => {
            await handleTelegramTurn(
              { update_id: 3, message: { text: "Hey", from: { username: "bob", id: 999 } } },
              deps,
            );
          },
        );
        piLoop.assertDrained(1);

        assert.equal(calls.length, 1, "the auto-reply path must call /sendMessage exactly once");
        const sendMsgCall = calls[0];
        assert.ok(sendMsgCall !== undefined, "the exact sendMessage call must exist");
        const bodyStr = sendMsgCall.body as string;
        const bodyObj = JSON.parse(bodyStr) as { chat_id: number; text: string };
        assert.equal(bodyObj.chat_id, 999, "auto-reply chat_id must be boundUserId=999");
        assert.equal(bodyObj.text, "Hi back", "auto-reply text must equal the final assistant tail");
      } finally {
        delete process.env.TELEGRAM_TOKEN;
      }
    } finally {
      restoreHome();
      cleanup();
    }
  });

  it("T-Turn.4 (sole owner of auto-reply truncation — NIT-B): when final assistant text is 5000 chars, auto-reply body is first 4000 chars + truncation suffix", async () => {
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
        piLoop.queue(async (opts) => appendAssistant(opts, longText));

        await withFetchSpy(
          async (url, init) => {
            if (url.endsWith("/sendMessage")) {
              calls.push({ url, body: init?.body });
              return makeOkTgResponse();
            }
            return unexpectedTelegramRoute(url);
          },
          async () => {
            await handleTelegramTurn(
              { update_id: 4, message: { text: "Long request", from: { username: "carol", id: 999 } } },
              deps,
            );
          },
        );
        piLoop.assertDrained(1);

        assert.equal(calls.length, 1, "truncated auto-reply must send exactly once");
        const sendMsgCall = calls[0];
        assert.ok(sendMsgCall !== undefined, "the truncated sendMessage call must exist");
        const bodyObj = JSON.parse(sendMsgCall.body as string) as { text: string };
        const sentText = bodyObj.text;
        const suffix = "… (truncated; see REPL or session log for full response)";
        assert.equal(sentText, `${"A".repeat(4000)}${suffix}`, "truncation must preserve the exact contract");
        assert.ok(sentText.length <= 4096, `auto-reply text must remain ≤ 4096 chars; got ${sentText.length}`);
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
          async (url) => unexpectedTelegramRoute(url),
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

  it("T-Turn.6: when message has voice field, user message content contains [TG_VOICE=<path>] AND no transcription occurs (D-14: no Whisper)", async () => {
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
        piLoop.queue(async (opts) => appendAssistant(opts, "Hi back"));

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
            if (url.endsWith("/sendMessage")) return makeOkTgResponse();
            return unexpectedTelegramRoute(url);
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
        piLoop.assertDrained(1);

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
  it("T-Session.1: when sessionFileRef.path is mutated AFTER telegramDeps is built, handleTelegramTurn appendMessages call receives the NEW path (object-ref share, not string snapshot)", async () => {
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
        piLoop.queue(async (opts) => appendAssistant(opts, "Session object-ref response"));

        // Step 3: call handleTelegramTurn
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
      cleanupTmpDir(dir2);
      restoreHome();
      cleanup();
    }
  });
});

// ─── T-Visibility: BUG-3 — handleTelegramTurn out.write visibility (P-12 G-P12.3) ──

describe("T-Visibility: handleTelegramTurn emits [telegram] ↓/↑ visibility lines (P-12 G-P12.3)", () => {
  it("T-Visibility.1: when text-only inbound update from alice (boundUserId=12345), deps.out captures '[telegram] ↓ @alice: Hi mai' BEFORE agent loop result", async () => {
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
        piLoop.queue(async (opts) => {
          assert.ok(
            lines.join("").includes("[telegram] ↓ @alice: Hi mai"),
            "inbound visibility must be emitted before the Pi loop",
          );
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

  it("T-Visibility.2: when agent returns 'Sure thing' AND sendTelegramMessage resolves, deps.out captures '[telegram] ↑ @alice: Sure thing' AFTER reply", async () => {
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
        const sendGate = deferred<Response>();
        const sendEntered = deferred<void>();
        piLoop.queue(async (opts) => appendAssistant(opts, "Sure thing"));
        await withFetchSpy(
          async (url) => {
            if (!url.endsWith("/sendMessage")) return unexpectedTelegramRoute(url);
            sendEntered.resolve();
            return sendGate.promise;
          },
          async () => {
            const turn = handleTelegramTurn(
              { update_id: 101, message: { text: "Hello", from: { username: "alice", id: 12345 } } },
              deps,
            );
            await sendEntered.promise;
            assert.equal(
              lines.join("").includes("[telegram] ↑ @alice: Sure thing"),
              false,
              "outbound visibility must remain absent while sendMessage is pending",
            );
            sendGate.resolve(makeOkTgResponse());
            await turn;
          },
        );
        piLoop.assertDrained(1);
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

  it("T-Visibility.3: when message is media-only (photo, textBody empty) AND download succeeds, the ↓ preview starts with '[TG_PHOTO=<localPath>]' (not empty string; OQ-6 media-preview)", async () => {
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
                  // biome-ignore lint/suspicious/noExplicitAny: test shape cast
                  photo: [{ file_id: "x", file_unique_id: "u" }] as any,
                  // NO text/caption — media-only
                },
              },
              deps,
            );
          },
        );
        piLoop.assertDrained(1);
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
