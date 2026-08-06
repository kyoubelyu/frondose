import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { downloadTelegramFile } from "../../src/tools/telegram/inboundMedia.js";

type Update = {
  updateId: number;
  text?: string;
  media?: Array<{ kind: string; fileId: string; fileUniqueId?: string }>;
};
type AuditEvent = { type: string; updateId: number };
type ChannelDeps = {
  configured: boolean;
  readOffset: () => number;
  commitOffset: (offset: number) => void;
  pollUpdates: (signal: AbortSignal, offset: number) => Promise<Update[]>;
  downloadMedia: (media: NonNullable<Update["media"]>[number], signal: AbortSignal) => Promise<string>;
  submitTurn: (
    input: { source: "telegram"; text: string; media: string[] },
    signal: AbortSignal,
  ) => Promise<{ finalText: string }>;
  sendReply: (text: string, signal: AbortSignal) => Promise<void>;
  writeAudit: (event: AuditEvent) => void;
  waitForNextPoll: (signal: AbortSignal) => Promise<void>;
};
type Channel = { start(): void; pollOnce(): Promise<void>; stop(): Promise<void> };
type ChannelModule = { createTelegramChannel(deps: ChannelDeps): Channel };

async function loadChannel(): Promise<ChannelModule> {
  const url = pathToFileURL(join(process.cwd(), "src/app/backend/telegramChannel.ts")).href;
  return (await import(url)) as ChannelModule;
}

function baseDeps(overrides: Partial<ChannelDeps> = {}): ChannelDeps {
  return {
    configured: true,
    readOffset: () => 40,
    commitOffset: () => {},
    pollUpdates: async () => [],
    downloadMedia: async ({ fileId }) => `/bounded/${fileId}`,
    submitTurn: async () => ({ finalText: "done" }),
    sendReply: async () => {},
    writeAudit: () => {},
    waitForNextPoll: (signal) =>
      new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    ...overrides,
  };
}

async function observeAutomaticOffsets(channel: Channel, offsets: number[], expected: number[]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  channel.start();
  try {
    await Promise.race([
      (async () => {
        while (offsets.length < expected.length) await new Promise((resolve) => setImmediate(resolve));
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`automatic polling timeout after offsets ${offsets.join(",")}`)),
          250,
        );
      }),
    ]);
    assert.deepEqual(offsets, expected);
  } finally {
    if (timer) clearTimeout(timer);
    await channel.stop();
  }
}

describe("P-OPEN-SOURCE-SPLIT App-owned Telegram channel", () => {
  // Given a configured channel, when start runs, then polling repeats from committed offsets until stop aborts and joins it.
  it("T-RETIRE.Telegram.1h: start automatically repeats polling with committed offsets", async () => {
    const offsets: number[] = [];
    let offset = 40;
    let wakeups = 0;
    const mod = await loadChannel();
    const channel = mod.createTelegramChannel(
      baseDeps({
        readOffset: () => offset,
        pollUpdates: async (_signal, current) => {
          offsets.push(current);
          return [{ updateId: current, text: `message-${current}` }];
        },
        commitOffset: (next) => {
          offset = next;
        },
        waitForNextPoll: async (signal) => {
          wakeups += 1;
          if (offset < 42) return;
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        },
      }),
    );
    await observeAutomaticOffsets(channel, offsets, [40, 41]);
    assert.equal(wakeups, 2);
  });

  // Given the bounded observer, when start is a no-op or schedules only once, then both mutations fail promptly and still stop.
  it("T-RETIRE.Telegram.1i: no-op and single-poll start mutations terminate RED", async () => {
    for (const offsets of [[], [40]]) {
      let stopped = false;
      const fake: Channel = {
        start: () => {},
        pollOnce: async () => {},
        stop: async () => {
          stopped = true;
        },
      };
      await assert.rejects(() => observeAutomaticOffsets(fake, offsets, [40, 41]), /automatic polling timeout/);
      assert.equal(stopped, true);
    }
  });

  // Given Telegram is unconfigured, when one poll is requested, then no transport, turn, reply, offset, or audit work occurs.
  it("T-RETIRE.Telegram.1a: unconfigured channel is inert", async () => {
    const calls: string[] = [];
    const mod = await loadChannel();
    const channel = mod.createTelegramChannel(
      baseDeps({
        configured: false,
        pollUpdates: async () => {
          calls.push("poll");
          return [];
        },
        submitTurn: async () => {
          calls.push("turn");
          return { finalText: "x" };
        },
        sendReply: async () => calls.push("reply"),
        commitOffset: () => calls.push("offset"),
        writeAudit: () => calls.push("audit"),
      }),
    );
    await channel.pollOnce();
    assert.deepEqual(calls, []);
  });

  // Given one bound text update, when the App accepts the turn, then the single App owner runs once, replies once, audits, then advances offset.
  it("T-RETIRE.Telegram.1b: successful update uses one App turn and commits only after one reply", async () => {
    const order: string[] = [];
    const audits: AuditEvent[] = [];
    const mod = await loadChannel();
    const channel = mod.createTelegramChannel(
      baseDeps({
        pollUpdates: async (_signal, offset) => {
          assert.equal(offset, 40);
          order.push("poll");
          return [{ updateId: 40, text: "hello" }];
        },
        submitTurn: async (input) => {
          order.push("turn");
          assert.deepEqual(input, { source: "telegram", text: "hello", media: [] });
          return { finalText: "reply" };
        },
        sendReply: async (text) => {
          order.push("reply");
          assert.equal(text, "reply");
        },
        writeAudit: (event) => {
          order.push(`audit:${event.type}`);
          audits.push(event);
        },
        commitOffset: (offset) => {
          order.push("offset");
          assert.equal(offset, 41);
        },
      }),
    );
    await channel.pollOnce();
    assert.equal(order.filter((entry) => entry === "turn").length, 1);
    assert.equal(order.filter((entry) => entry === "reply").length, 1);
    assert.ok(order.indexOf("offset") > order.indexOf("reply"));
    assert.deepEqual(
      audits.map((event) => event.type),
      ["telegram_inbound", "telegram_outbound"],
    );
    assert.deepEqual(order, ["poll", "audit:telegram_inbound", "turn", "reply", "audit:telegram_outbound", "offset"]);
  });

  // Given the shared App turn owner is busy, when submission rejects, then the update is deferred with no reply or offset advance.
  it("T-RETIRE.Telegram.1c: turn contention does not lose the update", async () => {
    const calls: string[] = [];
    const mod = await loadChannel();
    const channel = mod.createTelegramChannel(
      baseDeps({
        pollUpdates: async () => [{ updateId: 40, text: "wait" }],
        submitTurn: async () => {
          calls.push("turn");
          throw new Error("turn_busy");
        },
        sendReply: async () => calls.push("reply"),
        commitOffset: () => calls.push("offset"),
      }),
    );
    await assert.rejects(() => channel.pollOnce(), /turn_busy/);
    assert.deepEqual(calls, ["turn"]);
  });

  // Given a media update, when processed, then the real bounded inboundMedia helper writes under the allowlist before App submission.
  it("T-RETIRE.Telegram.1d: real bounded media enters the same App turn", async () => {
    const order: string[] = [];
    const allowlist = mkdtempSync(join(tmpdir(), "frondose-telegram-media-"));
    const mod = await loadChannel();
    const channel = mod.createTelegramChannel(
      baseDeps({
        pollUpdates: async () => [
          { updateId: 40, media: [{ kind: "photo", fileId: "f1", fileUniqueId: "unique-f1" }] },
        ],
        downloadMedia: async (media) => {
          order.push("download");
          let call = 0;
          const result = await downloadTelegramFile(
            "token",
            media.fileId,
            media.fileUniqueId ?? "",
            allowlist,
            async () => {
              call += 1;
              return call === 1
                ? new Response(JSON.stringify({ ok: true, result: { file_path: "photo/f1.jpg", file_size: 3 } }), {
                    headers: { "content-type": "application/json" },
                  })
                : new Response(Buffer.from([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
            },
          );
          assert.ok(result.localPath.startsWith(allowlist));
          assert.equal(existsSync(result.localPath), true);
          return result.localPath;
        },
        submitTurn: async (input) => {
          order.push("turn");
          assert.equal(input.media.length, 1);
          assert.ok(input.media[0]?.startsWith(allowlist));
          return { finalText: "seen" };
        },
      }),
    );
    try {
      await channel.pollOnce();
      assert.deepEqual(order, ["download", "turn"]);
    } finally {
      rmSync(allowlist, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  // Given an in-flight long poll, when channel shutdown runs, then the poll aborts and stop awaits cleanup without committing state.
  it("T-RETIRE.Telegram.1e: shutdown aborts and joins the poller", async () => {
    let sawAbort = false;
    let committed = false;
    const mod = await loadChannel();
    const channel = mod.createTelegramChannel(
      baseDeps({
        pollUpdates: (signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              sawAbort = true;
              resolve([]);
            });
          }),
        commitOffset: () => {
          committed = true;
        },
      }),
    );
    const polling = channel.pollOnce();
    await channel.stop();
    await polling;
    assert.equal(sawAbort, true);
    assert.equal(committed, false);
  });

  // Given each non-terminal failure class, when processing fails, then no offset is committed and no later stage runs.
  it("T-RETIRE.Telegram.1f: turn, App abort, reply, and audit failures retain the update", async () => {
    const cases: Array<{ name: string; overrides: Partial<ChannelDeps> }> = [
      {
        name: "turn",
        overrides: {
          submitTurn: async () => {
            throw new Error("turn_failed");
          },
        },
      },
      {
        name: "abort",
        overrides: {
          submitTurn: async () => {
            throw new DOMException("aborted", "AbortError");
          },
        },
      },
      {
        name: "reply",
        overrides: {
          sendReply: async () => {
            throw new Error("reply_failed");
          },
        },
      },
      {
        name: "audit",
        overrides: {
          writeAudit: (event) => {
            if (event.type === "telegram_outbound") throw new Error("audit_failed");
          },
        },
      },
    ];
    const mod = await loadChannel();
    for (const entry of cases) {
      let committed = false;
      const channel = mod.createTelegramChannel(
        baseDeps({
          pollUpdates: async () => [{ updateId: 40, text: entry.name }],
          commitOffset: () => {
            committed = true;
          },
          ...entry.overrides,
        }),
      );
      await assert.rejects(() => channel.pollOnce(), undefined, entry.name);
      assert.equal(committed, false, entry.name);
    }
  });

  // Given shutdown during media, turn, or reply, when stop runs, then each stage sees abort and stop joins it without offset advancement.
  it("T-RETIRE.Telegram.1g: shutdown joins every in-flight processing stage", async () => {
    const mod = await loadChannel();
    for (const stage of ["media", "turn", "reply"] as const) {
      let entered = false;
      let committed = false;
      const waitForAbort = (signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          entered = true;
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      const channel = mod.createTelegramChannel(
        baseDeps({
          pollUpdates: async () => [
            { updateId: 40, text: "x", media: stage === "media" ? [{ kind: "photo", fileId: "f" }] : undefined },
          ],
          downloadMedia: stage === "media" ? async (_media, signal) => waitForAbort(signal) : async () => "/bounded/f",
          submitTurn:
            stage === "turn" ? async (_input, signal) => waitForAbort(signal) : async () => ({ finalText: "ok" }),
          sendReply: stage === "reply" ? async (_text, signal) => waitForAbort(signal) : async () => {},
          commitOffset: () => {
            committed = true;
          },
        }),
      );
      const work = channel.pollOnce();
      while (!entered) await new Promise((resolve) => setImmediate(resolve));
      await channel.stop();
      await assert.rejects(() => work, /abort/i);
      assert.equal(committed, false);
    }
  });
});
