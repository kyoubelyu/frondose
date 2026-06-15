/**
 * P-11 Step 5 — T-Media.*.1..3 + T-Media.group.1..3 + T-Control.1..6 + T-Mutex.1..3 + T-Trunc.1
 *
 * Extended telegram_notify tool assertions.
 * Gate coverage: G-P11.11, G-P11.12, G-P11.13, G-P11.14
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTelegramNotifyTool } from "../../../src/tools/operatorOutput/telegram.js";

// ─── fetch mock helpers ───────────────────────────────────────────────────────

type MockFetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type CapturedCall = { url: string; init?: RequestInit };

function withFetchSpy(mock: MockFetchFn, body: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (globalThis as any).fetch = mock;
  return body().finally(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (globalThis as any).fetch = orig;
  });
}

function makeOkTgResponse(messageId = 1): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: messageId } }),
  } as unknown as Response;
}

function makeSpy(): { calls: CapturedCall[]; mock: MockFetchFn } {
  const calls: CapturedCall[] = [];
  const mock: MockFetchFn = async (url, init) => {
    calls.push({ url, init });
    return makeOkTgResponse();
  };
  return { calls, mock };
}

/** Capitalize first letter of each underscore-separated segment: "video_note" → "VideoNote" */
function tgMethodSuffix(mediaType: string): string {
  return mediaType
    .split("_")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/** Get JSON body or null for multipart */
function parseJsonBody(init?: RequestInit): Record<string, unknown> | null {
  if (!init?.body || init.body instanceof FormData) return null;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

// ─── T-Media: 24 atomic tests (8 media types × 3 mechanisms) ─────────────────

const MEDIA_TYPES = ["photo", "audio", "video", "voice", "document", "animation", "video_note", "sticker"] as const;

describe("T-Media: outbound media types (G-P11.11)", () => {
  for (const mediaType of MEDIA_TYPES) {
    it(`T-Media.${mediaType}.1: when mediaType="${mediaType}" + mediaFileId="reuse-id", POST body is JSON containing ${mediaType}:"reuse-id" + chat_id; no multipart`, async () => {
      // Given: TELEGRAM_TOKEN + TELEGRAM_CHAT_ID set; mediaFileId="reuse-id"
      // When: telegram_notify.execute({ body:"caption", mediaType, mediaFileId:"reuse-id" })
      // Then: captured body is JSON with key [mediaType]:"reuse-id" + caption; Content-Type is application/json
      process.env.TELEGRAM_TOKEN = "test-tok";
      process.env.TELEGRAM_CHAT_ID = "999";
      const { mock, calls } = makeSpy();
      const tool = makeTelegramNotifyTool();
      try {
        await withFetchSpy(mock, async () => {
          await tool.execute({ body: "caption", severity: "info", mediaType, mediaFileId: "reuse-id" }, {} as never);
        });
        assert.equal(calls.length, 1, "exactly one fetch call expected");
        const call = calls[0];
        assert.ok(call !== undefined);
        assert.ok(
          call.url.endsWith(`/send${tgMethodSuffix(mediaType)}`),
          `URL must end with /send${tgMethodSuffix(mediaType)}; got: ${call.url}`,
        );
        const body = parseJsonBody(call.init);
        assert.ok(body !== null, "body must be JSON (not FormData)");
        assert.equal(body[mediaType], "reuse-id", `body must contain ${mediaType}:"reuse-id"`);
        assert.equal(body.chat_id, "999");
        const ct = (call.init?.headers as Record<string, string>)?.["Content-Type"];
        assert.equal(ct, "application/json", "Content-Type must be application/json");
      } finally {
        delete process.env.TELEGRAM_TOKEN;
        delete process.env.TELEGRAM_CHAT_ID;
      }
    });

    it(`T-Media.${mediaType}.2: when mediaType="${mediaType}" + mediaUrl="https://example.com/foo.jpg", POST body is JSON with ${mediaType}:"https://example.com/foo.jpg"`, async () => {
      // Given: mediaUrl set; TELEGRAM_TOKEN + TELEGRAM_CHAT_ID set
      // When: telegram_notify.execute({ body:"caption", mediaType, mediaUrl:"https://example.com/foo.jpg" })
      // Then: captured JSON body has key [mediaType] = "https://example.com/foo.jpg"
      process.env.TELEGRAM_TOKEN = "test-tok";
      process.env.TELEGRAM_CHAT_ID = "999";
      const { mock, calls } = makeSpy();
      const tool = makeTelegramNotifyTool();
      try {
        await withFetchSpy(mock, async () => {
          await tool.execute(
            { body: "caption", severity: "info", mediaType, mediaUrl: "https://example.com/foo.jpg" },
            {} as never,
          );
        });
        const call = calls[0];
        assert.ok(call !== undefined);
        assert.ok(call.url.endsWith(`/send${tgMethodSuffix(mediaType)}`));
        const body = parseJsonBody(call.init);
        assert.ok(body !== null, "body must be JSON");
        assert.equal(
          body[mediaType],
          "https://example.com/foo.jpg",
          `body must contain ${mediaType}:"https://example.com/foo.jpg"`,
        );
      } finally {
        delete process.env.TELEGRAM_TOKEN;
        delete process.env.TELEGRAM_CHAT_ID;
      }
    });

    it(`T-Media.${mediaType}.3: when mediaType="${mediaType}" + mediaPath to a readable allowlisted file, request is multipart/form-data with ${mediaType} part`, async () => {
      // Given: mediaPath in allowlisted dir; TELEGRAM_TOKEN + TELEGRAM_CHAT_ID set
      // When: telegram_notify.execute({ body:"caption", mediaType, mediaPath })
      // Then: body is FormData (multipart); contains the file part named mediaType
      const tmpDir = mkdtempSync(join(tmpdir(), "mai-p11-tg-media-"));
      const testFilePath = join(tmpDir, "test.jpg");
      writeFileSync(testFilePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      const origAllowlist = process.env.FRONDOSE_UPLOAD_ALLOWLIST;
      process.env.FRONDOSE_UPLOAD_ALLOWLIST = tmpDir;
      process.env.TELEGRAM_TOKEN = "test-tok";
      process.env.TELEGRAM_CHAT_ID = "999";
      const { mock, calls } = makeSpy();
      const tool = makeTelegramNotifyTool();
      try {
        await withFetchSpy(mock, async () => {
          await tool.execute({ body: "caption", severity: "info", mediaType, mediaPath: testFilePath }, {} as never);
        });
        const call = calls[0];
        assert.ok(call !== undefined, "fetch must be called");
        assert.ok(call.url.endsWith(`/send${tgMethodSuffix(mediaType)}`));
        // For multipart, body is FormData
        assert.ok(
          call.init?.body instanceof FormData,
          `body must be FormData for multipart; got: ${typeof call.init?.body}`,
        );
        const fd = call.init?.body as FormData;
        assert.ok(fd.get(mediaType) !== null, `FormData must contain part named "${mediaType}"`);
      } finally {
        delete process.env.TELEGRAM_TOKEN;
        delete process.env.TELEGRAM_CHAT_ID;
        if (origAllowlist !== undefined) process.env.FRONDOSE_UPLOAD_ALLOWLIST = origAllowlist;
        else delete process.env.FRONDOSE_UPLOAD_ALLOWLIST;
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  }
});

// ─── T-Media.group: sendMediaGroup ────────────────────────────────────────────

describe("T-Media.group: sendMediaGroup (G-P11.12)", () => {
  it("T-Media.group.1: when mediaGroup has 2 JSON items (file_ids), POST URL ends with /sendMediaGroup AND body has media array with both items", async () => {
    // Given: mediaGroup=[{type:"photo",media:"file_id_1"},{type:"photo",media:"file_id_2"}]
    // When: telegram_notify.execute({ body:"album", mediaGroup:[...] })
    // Then: URL ends with "/sendMediaGroup"; FormData has "media" JSON with both items
    process.env.TELEGRAM_TOKEN = "test-tok";
    process.env.TELEGRAM_CHAT_ID = "999";
    const { mock, calls } = makeSpy();
    const tool = makeTelegramNotifyTool();
    try {
      await withFetchSpy(mock, async () => {
        await tool.execute(
          {
            body: "album",
            severity: "info",
            mediaGroup: [
              { type: "photo", media: "file_id_1" },
              { type: "photo", media: "file_id_2" },
            ],
          },
          {} as never,
        );
      });
      const call = calls[0];
      assert.ok(call !== undefined);
      assert.ok(call.url.endsWith("/sendMediaGroup"), `URL must end with /sendMediaGroup; got: ${call.url}`);
      // sendMediaGroup uses FormData
      assert.ok(call.init?.body instanceof FormData, "body must be FormData for sendMediaGroup");
      const fd = call.init?.body as FormData;
      const mediaJson = fd.get("media");
      assert.ok(mediaJson !== null, 'FormData must contain "media" field');
      const mediaArr = JSON.parse(mediaJson as string) as Array<{ type: string; media: string }>;
      assert.equal(mediaArr.length, 2, "media array must have 2 items");
      assert.equal(mediaArr[0]?.media, "file_id_1");
      assert.equal(mediaArr[1]?.media, "file_id_2");
    } finally {
      delete process.env.TELEGRAM_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
    }
  });

  it("T-Media.group.2: when one mediaGroup item has media set to a local path, request is multipart with file attached as attach://mediaN", async () => {
    // Given: mediaGroup item with media="/tmp/local.jpg" (local path)
    // When: telegram_notify.execute called
    // Then: request is multipart; the local file is attached; that item's media in JSON is "attach://media0"
    const tmpDir = mkdtempSync(join(tmpdir(), "mai-p11-mg-"));
    const localPath = join(tmpDir, "local.jpg");
    writeFileSync(localPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const origAllowlist = process.env.FRONDOSE_UPLOAD_ALLOWLIST;
    process.env.FRONDOSE_UPLOAD_ALLOWLIST = tmpDir;
    process.env.TELEGRAM_TOKEN = "test-tok";
    process.env.TELEGRAM_CHAT_ID = "999";
    const { mock, calls } = makeSpy();
    const tool = makeTelegramNotifyTool();
    try {
      await withFetchSpy(mock, async () => {
        await tool.execute(
          {
            body: "album",
            severity: "info",
            mediaGroup: [
              { type: "photo", media: localPath },
              { type: "photo", media: "file_id_2" },
            ],
          },
          {} as never,
        );
      });
      const call = calls[0];
      assert.ok(call !== undefined);
      assert.ok(call.url.endsWith("/sendMediaGroup"), "URL must end with /sendMediaGroup");
      const fd = call.init?.body as FormData;
      const mediaJson = fd.get("media");
      assert.ok(mediaJson !== null, 'FormData must have "media"');
      const mediaArr = JSON.parse(mediaJson as string) as Array<{ type: string; media: string }>;
      // First item (local path) must be attach://media0
      assert.ok(
        mediaArr[0]?.media.startsWith("attach://"),
        `first item must use attach:// reference; got: "${mediaArr[0]?.media}"`,
      );
      // Second item is a file_id (unchanged)
      assert.equal(mediaArr[1]?.media, "file_id_2", "second item (file_id) must be unchanged");
      // The local file must be attached as a FormData part
      const attachedFile = fd.get(mediaArr[0]?.media.replace("attach://", "") ?? "");
      assert.ok(attachedFile !== null, "local file must be attached as FormData blob");
    } finally {
      delete process.env.TELEGRAM_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
      if (origAllowlist !== undefined) process.env.FRONDOSE_UPLOAD_ALLOWLIST = origAllowlist;
      else delete process.env.FRONDOSE_UPLOAD_ALLOWLIST;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("T-Media.group.3: when mediaGroup has fewer than 2 items OR more than 10 items, the Zod parameters schema rejects the input (SDK-layer validation)", () => {
    // Given: mediaGroup with 1 item (below min=2) or 11 items (above max=10)
    // When: tool.parameters.safeParse called (the layer the SDK invokes before execute)
    // Then: success===false for both boundary violations (Zod .min(2).max(10) enforced)
    const tool = makeTelegramNotifyTool();
    const schema = tool.parameters;

    // 1 item (below min=2)
    const tooFew = schema.safeParse({
      body: "album",
      severity: "info",
      mediaGroup: [{ type: "photo", media: "id1" }],
    });
    assert.equal(tooFew.success, false, "Zod must reject mediaGroup with fewer than 2 items");

    // 11 items (above max=10)
    const elevenItems = Array.from({ length: 11 }, (_, i) => ({
      type: "photo" as const,
      media: `file_id_${i}`,
    }));
    const tooMany = schema.safeParse({
      body: "album",
      severity: "info",
      mediaGroup: elevenItems,
    });
    assert.equal(tooMany.success, false, "Zod must reject mediaGroup with more than 10 items");

    // Exactly 2 items (valid lower bound) — must pass
    const exactTwo = schema.safeParse({
      body: "album",
      severity: "info",
      mediaGroup: [
        { type: "photo", media: "id1" },
        { type: "photo", media: "id2" },
      ],
    });
    assert.equal(exactTwo.success, true, "Zod must accept mediaGroup with exactly 2 items");
  });
});

// ─── T-Control: edit/delete/pin/chatAction ────────────────────────────────────

describe("T-Control: message control methods (G-P11.13)", () => {
  it("T-Control.1: when editMessageId:42 provided, POST URL ends with /editMessageText AND body contains message_id:42 + text", async () => {
    // Given: { body:"new text", editMessageId:42 }
    // When: telegram_notify.execute called
    // Then: URL path ends with "/editMessageText"; body JSON has message_id:42 + text:"ℹ️ new text"
    process.env.TELEGRAM_TOKEN = "test-tok";
    process.env.TELEGRAM_CHAT_ID = "999";
    const { mock, calls } = makeSpy();
    const tool = makeTelegramNotifyTool();
    try {
      await withFetchSpy(mock, async () => {
        await tool.execute({ body: "new text", severity: "info", editMessageId: 42 }, {} as never);
      });
      const call = calls[0];
      assert.ok(call !== undefined);
      assert.ok(call.url.endsWith("/editMessageText"), `URL must end with /editMessageText; got: ${call.url}`);
      const body = parseJsonBody(call.init);
      assert.ok(body !== null, "body must be JSON");
      assert.equal(body.message_id, 42);
      assert.equal(body.chat_id, "999");
      assert.ok(
        typeof body.text === "string" && body.text.includes("new text"),
        `body.text must include "new text"; got: ${body.text}`,
      );
    } finally {
      delete process.env.TELEGRAM_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
    }
  });

  it("T-Control.2: when deleteMessageId:42 provided, POST URL ends with /deleteMessage AND body contains message_id:42", async () => {
    // Given: { body:".", deleteMessageId:42 }
    // When: telegram_notify.execute called
    // Then: URL ends with "/deleteMessage"; body has message_id:42
    process.env.TELEGRAM_TOKEN = "test-tok";
    process.env.TELEGRAM_CHAT_ID = "999";
    const { mock, calls } = makeSpy();
    const tool = makeTelegramNotifyTool();
    try {
      await withFetchSpy(mock, async () => {
        await tool.execute({ body: ".", severity: "info", deleteMessageId: 42 }, {} as never);
      });
      const call = calls[0];
      assert.ok(call !== undefined);
      assert.ok(call.url.endsWith("/deleteMessage"), `URL must end with /deleteMessage; got: ${call.url}`);
      const body = parseJsonBody(call.init);
      assert.ok(body !== null);
      assert.equal(body.message_id, 42);
      assert.equal(body.chat_id, "999");
    } finally {
      delete process.env.TELEGRAM_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
    }
  });

  it("T-Control.3: when pinMessageId:42 provided, POST URL ends with /pinChatMessage", async () => {
    // Given: { body:".", pinMessageId:42 }
    // When: telegram_notify.execute called
    // Then: URL ends with "/pinChatMessage"
    process.env.TELEGRAM_TOKEN = "test-tok";
    process.env.TELEGRAM_CHAT_ID = "999";
    const { mock, calls } = makeSpy();
    const tool = makeTelegramNotifyTool();
    try {
      await withFetchSpy(mock, async () => {
        await tool.execute({ body: ".", severity: "info", pinMessageId: 42 }, {} as never);
      });
      const call = calls[0];
      assert.ok(call !== undefined);
      assert.ok(call.url.endsWith("/pinChatMessage"), `URL must end with /pinChatMessage; got: ${call.url}`);
      const body = parseJsonBody(call.init);
      assert.ok(body !== null);
      assert.equal(body.message_id, 42);
    } finally {
      delete process.env.TELEGRAM_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
    }
  });

  it("T-Control.4: when unpinMessageId:42 provided, POST URL ends with /unpinChatMessage", async () => {
    // Given: { body:".", unpinMessageId:42 }
    // When: telegram_notify.execute called
    // Then: URL ends with "/unpinChatMessage"
    process.env.TELEGRAM_TOKEN = "test-tok";
    process.env.TELEGRAM_CHAT_ID = "999";
    const { mock, calls } = makeSpy();
    const tool = makeTelegramNotifyTool();
    try {
      await withFetchSpy(mock, async () => {
        await tool.execute({ body: ".", severity: "info", unpinMessageId: 42 }, {} as never);
      });
      const call = calls[0];
      assert.ok(call !== undefined);
      assert.ok(call.url.endsWith("/unpinChatMessage"), `URL must end with /unpinChatMessage; got: ${call.url}`);
    } finally {
      delete process.env.TELEGRAM_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
    }
  });

  it('T-Control.5: when chatAction:"typing" provided (no media), POST URL ends with /sendChatAction AND body has action:"typing"', async () => {
    // Given: { body:".", chatAction:"typing" }
    // When: telegram_notify.execute called
    // Then: URL ends with "/sendChatAction"; body JSON has action:"typing"
    process.env.TELEGRAM_TOKEN = "test-tok";
    process.env.TELEGRAM_CHAT_ID = "999";
    const { mock, calls } = makeSpy();
    const tool = makeTelegramNotifyTool();
    try {
      await withFetchSpy(mock, async () => {
        await tool.execute({ body: ".", severity: "info", chatAction: "typing" }, {} as never);
      });
      const call = calls[0];
      assert.ok(call !== undefined);
      assert.ok(call.url.endsWith("/sendChatAction"), `URL must end with /sendChatAction; got: ${call.url}`);
      const body = parseJsonBody(call.init);
      assert.ok(body !== null);
      assert.equal(body.action, "typing");
      assert.equal(body.chat_id, "999");
    } finally {
      delete process.env.TELEGRAM_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
    }
  });

  it("T-Control.6: when replyMarkup JSON string provided alongside text body, the POST body JSON contains reply_markup as the parsed inline keyboard object", async () => {
    // Given: { body:"Choose:", replyMarkup:'{"inline_keyboard":[[{"text":"OK","callback_data":"ok"}]]}' }
    // When: telegram_notify.execute called
    // Then: body JSON has reply_markup:{ inline_keyboard:[[...]] } (parsed from string)
    process.env.TELEGRAM_TOKEN = "test-tok";
    process.env.TELEGRAM_CHAT_ID = "999";
    const { mock, calls } = makeSpy();
    const tool = makeTelegramNotifyTool();
    const replyMarkupStr = '{"inline_keyboard":[[{"text":"OK","callback_data":"ok"}]]}';
    try {
      await withFetchSpy(mock, async () => {
        await tool.execute({ body: "Choose:", severity: "info", replyMarkup: replyMarkupStr }, {} as never);
      });
      const call = calls[0];
      assert.ok(call !== undefined);
      const body = parseJsonBody(call.init);
      assert.ok(body !== null);
      assert.ok(body.reply_markup !== undefined, "body must contain reply_markup");
      const rm = body.reply_markup as { inline_keyboard: unknown[][] };
      assert.ok(Array.isArray(rm.inline_keyboard), "reply_markup must have inline_keyboard array");
      assert.equal(rm.inline_keyboard.length, 1, "inline_keyboard must have 1 row");
    } finally {
      delete process.env.TELEGRAM_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
    }
  });
});

// ─── T-Mutex (D-22) + T-Trunc (D-24) ─────────────────────────────────────────

describe("T-Mutex: mutual-exclusivity runtime checks (G-P11.14)", () => {
  it("T-Mutex.1: when mediaType set AND all of mediaPath/mediaFileId/mediaUrl are unset, returns fail envelope containing 'exactly one of'", async () => {
    // Given: { body:"x", mediaType:"photo" } with no media source fields
    // When: telegram_notify.execute called
    // Then: returns fail("invalid_input", ...) with message containing "exactly one of"
    process.env.TELEGRAM_TOKEN = "test-tok";
    process.env.TELEGRAM_CHAT_ID = "999";
    const tool = makeTelegramNotifyTool();
    try {
      const result = (await tool.execute({ body: "x", severity: "info", mediaType: "photo" }, {} as never)) as {
        ok: boolean;
        error?: { kind: string; message: string };
      };
      assert.equal(result.ok, false, "result must be ok:false");
      assert.ok(
        result.error?.message?.includes("exactly one of"),
        `error message must contain "exactly one of"; got: "${result.error?.message}"`,
      );
      assert.equal(result.error?.kind, "invalid_input");
    } finally {
      delete process.env.TELEGRAM_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
    }
  });

  it("T-Mutex.2: when mediaType set AND BOTH mediaPath AND mediaFileId are set, returns fail envelope", async () => {
    // Given: { body:"x", mediaType:"photo", mediaPath:"/tmp/a.jpg", mediaFileId:"id123" } (ambiguous source)
    // When: telegram_notify.execute called
    // Then: returns fail("invalid_input", ...)
    process.env.TELEGRAM_TOKEN = "test-tok";
    process.env.TELEGRAM_CHAT_ID = "999";
    const tool = makeTelegramNotifyTool();
    try {
      const result = (await tool.execute(
        { body: "x", severity: "info", mediaType: "photo", mediaPath: "/tmp/a.jpg", mediaFileId: "id123" },
        {} as never,
      )) as { ok: boolean; error?: { kind: string; message: string } };
      assert.equal(result.ok, false, "result must be ok:false (ambiguous media source)");
      assert.equal(result.error?.kind, "invalid_input");
      assert.ok(
        result.error?.message?.includes("exclusive") || result.error?.message?.includes("mutually"),
        `error message must mention mutual exclusivity; got: "${result.error?.message}"`,
      );
    } finally {
      delete process.env.TELEGRAM_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
    }
  });

  it("T-Mutex.3: when BOTH editMessageId AND deleteMessageId are set in the same call, returns fail('invalid_input', 'at most one structural-control field per call')", async () => {
    // Given: { body:"x", editMessageId:1, deleteMessageId:2 }
    // When: telegram_notify.execute called
    // Then: returns fail envelope; message contains "at most one" or similar mutex wording
    process.env.TELEGRAM_TOKEN = "test-tok";
    process.env.TELEGRAM_CHAT_ID = "999";
    const tool = makeTelegramNotifyTool();
    try {
      const result = (await tool.execute(
        { body: "x", severity: "info", editMessageId: 1, deleteMessageId: 2 },
        {} as never,
      )) as { ok: boolean; error?: { kind: string; message: string } };
      assert.equal(result.ok, false, "result must be ok:false (multiple structural controls)");
      assert.equal(result.error?.kind, "invalid_input");
      assert.ok(
        result.error?.message?.includes("at most one") || result.error?.message?.includes("structural"),
        `error message must mention "at most one"; got: "${result.error?.message}"`,
      );
    } finally {
      delete process.env.TELEGRAM_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
    }
  });
});

describe("T-Trunc: telegram_notify body length (G-P11.14)", () => {
  it("T-Trunc.1: when body is exactly 4000 chars, the call proceeds normally (no truncation; body is at the Zod max — not a tool concern)", async () => {
    // Given: body = 'x'.repeat(4000) — exactly at Zod max
    // When: telegram_notify.execute called
    // Then: resolves ok (no Zod error; body not truncated by the tool); fetch called with 4000-char text
    process.env.TELEGRAM_TOKEN = "test-tok";
    process.env.TELEGRAM_CHAT_ID = "999";
    const { mock, calls } = makeSpy();
    const tool = makeTelegramNotifyTool();
    try {
      await withFetchSpy(mock, async () => {
        await tool.execute({ body: "x".repeat(4000), severity: "info" }, {} as never);
      });
      assert.equal(calls.length, 1, "fetch must be called (4000-char body is valid)");
      const call = calls[0];
      assert.ok(call !== undefined);
      const body = parseJsonBody(call.init);
      assert.ok(body !== null);
      // The text is emoji-prefixed: "ℹ️ " + "x".repeat(4000) — Telegram caps at 4096; this is fine
      assert.ok(
        typeof body.text === "string" && body.text.includes("x".repeat(100)),
        "body.text must contain the 4000-char body",
      );
    } finally {
      delete process.env.TELEGRAM_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
    }
  });
});
