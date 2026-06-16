/**
 * P-11 Step 5 — T-Inbox.1..T-Inbox.7 (filled assertions)
 *
 * downloadTelegramFile + mediaTagFor (src/tools/telegram/inboundMedia.ts).
 * Gate coverage: G-P11.9, G-P11.10
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { downloadTelegramFile, mediaTagFor } from "../../../src/tools/telegram/inboundMedia.js";
import { cleanupTmpDir } from "../../_helpers/tmp";

// ─── helpers ─────────────────────────────────────────────────────────────────

type Transport = (url: string, init?: RequestInit) => Promise<Response>;

function makeTmpRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "mai-p11-inbox-"));
  return { root, cleanup: () => cleanupTmpDir(root) };
}

/** Returns a transport mock: getFile → fileInfo; binary download → bytes. */
function makeTransportMock(
  fileInfo: { ok: boolean; result?: { file_path: string; file_size?: number }; description?: string },
  fileBytes?: Buffer,
): Transport {
  return async (url: string) => {
    if (url.includes("/getFile")) {
      return {
        ok: true,
        json: async () => fileInfo,
      } as unknown as Response;
    }
    // Binary download
    return {
      ok: fileBytes !== undefined,
      status: fileBytes !== undefined ? 200 : 404,
      arrayBuffer: async () => (fileBytes ?? Buffer.alloc(0)).buffer,
      headers: { get: (h: string) => (h === "content-type" ? "image/jpeg" : null) },
    } as unknown as Response;
  };
}

// ─── T-Inbox: inbound media download ─────────────────────────────────────────

describe("downloadTelegramFile + mediaTagFor (G-P11.9, G-P11.10)", () => {
  it("T-Inbox.1: 5-param signature — downloads file, writes to telegram-inbox subdir with collision-safe name, returns {localPath, mimeType}", async () => {
    // Given: 5-param call with fileUniqueId="abq_unique" (last-8 = "q_unique"); transport returns { file_path:"photos/file_0.jpg", file_size:42000 } + JPEG bytes
    // When: downloadTelegramFile("token", "ABC123_fileId", "abq_unique", root, transport)
    // Then: (a) bytes written to ${root}/telegram-inbox/{ts}_{last8 of fileUniqueId}.jpg; (b) returns {localPath, mimeType:"image/jpeg"}
    const { root, cleanup } = makeTmpRoot();
    try {
      const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      const transport = makeTransportMock(
        { ok: true, result: { file_path: "photos/file_0.jpg", file_size: 42000 } },
        jpegBytes,
      );
      // fileUniqueId = "abq_unique" → last 8 chars = "q_unique" (slice(-8) of 10-char string)
      const result = await downloadTelegramFile("test-token", "ABC123_fileId", "abq_unique", root, transport);

      assert.ok(result.localPath.includes("telegram-inbox"), "localPath must be inside telegram-inbox/");
      assert.ok(result.localPath.endsWith(".jpg"), "localPath must have .jpg extension from file_path");
      // Collision-safe suffix from fileUniqueId last 8 chars: "q_unique" (last 8 of "abq_unique")
      assert.ok(
        result.localPath.includes("q_unique"),
        `localPath must contain fileUniqueId last-8 ("q_unique"); got: ${result.localPath}`,
      );
      assert.equal(result.mimeType, "image/jpeg", "mimeType must be image/jpeg");
      assert.ok(existsSync(result.localPath), "file must be written to disk");
    } finally {
      cleanup();
    }
  });

  it("T-Inbox.2: 5-param — when getFile returns file_size > 20 MB (21000000 bytes), throws containing '20 MB'; does NOT make binary download fetch", async () => {
    // Given: getFile returns { ok:true, result:{ file_size:21000000, file_path:"f.jpg" } }
    // When: downloadTelegramFile called; transport spy counts calls
    // Then: throws; error message contains "20 MB" + actual size; binary download NOT called
    const { root, cleanup } = makeTmpRoot();
    try {
      let callCount = 0;
      const transport: Transport = async (url) => {
        callCount++;
        if (url.includes("/getFile")) {
          return {
            ok: true,
            json: async () => ({ ok: true, result: { file_path: "f.jpg", file_size: 21_000_000 } }),
          } as unknown as Response;
        }
        // Should never reach binary download
        return {
          ok: true,
          arrayBuffer: async () => Buffer.alloc(0).buffer,
          headers: { get: () => null },
        } as unknown as Response;
      };

      await assert.rejects(
        () => downloadTelegramFile("tok", "fid", "funiq", root, transport),
        (err: Error) => {
          assert.ok(err.message.includes("20 MB"), `error must mention "20 MB"; got: "${err.message}"`);
          return true;
        },
      );
      assert.equal(callCount, 1, "binary download must NOT be called (only getFile call)");
    } finally {
      cleanup();
    }
  });

  it("T-Inbox.3: 5-param — two downloads in the same second with DIFFERENT fileUniqueId values produce DIFFERENT localPaths (collision avoided via fileUniqueId-last8)", async () => {
    // Given: two calls with fileUniqueId_A and fileUniqueId_B differing in last 8 chars; both in same second
    // When: both downloads complete
    // Then: localPaths differ; both files exist
    const { root, cleanup } = makeTmpRoot();
    try {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
      const transportA = makeTransportMock({ ok: true, result: { file_path: "docs/file.png", file_size: 100 } }, bytes);
      const transportB = makeTransportMock({ ok: true, result: { file_path: "docs/file.png", file_size: 100 } }, bytes);

      const [resultA, resultB] = await Promise.all([
        downloadTelegramFile("tok", "fidA", "uniqueId_AAAAAAAA", root, transportA),
        downloadTelegramFile("tok", "fidB", "uniqueId_BBBBBBBB", root, transportB),
      ]);

      assert.notEqual(resultA.localPath, resultB.localPath, "localPaths must differ (collision avoided)");
      assert.ok(existsSync(resultA.localPath), "file A must exist");
      assert.ok(existsSync(resultB.localPath), "file B must exist");
    } finally {
      cleanup();
    }
  });

  it("T-Inbox.4: 5-param — when telegram-inbox subdir does NOT exist, it is created via mkdirSync({ recursive:true }) before writing", async () => {
    // Given: allowlistRoot has NO telegram-inbox subdirectory
    // When: downloadTelegramFile called
    // Then: telegram-inbox dir created; file written successfully
    const { root, cleanup } = makeTmpRoot();
    try {
      const inboxDir = join(root, "telegram-inbox");
      // Verify it doesn't exist yet
      assert.ok(!existsSync(inboxDir), "telegram-inbox must not exist before download");

      const transport = makeTransportMock(
        { ok: true, result: { file_path: "voice/voice.ogg", file_size: 1024 } },
        Buffer.from([0x4f, 0x67, 0x67, 0x53]), // OGG magic
      );

      const result = await downloadTelegramFile("tok", "fid", "voiceuniq", root, transport);
      assert.ok(existsSync(inboxDir), "telegram-inbox subdir must be created automatically");
      assert.ok(existsSync(result.localPath), "file must be written");
    } finally {
      cleanup();
    }
  });

  it("T-Inbox.5: mediaTagFor maps all 8 Telegram media fields to correct [TG_<TYPE>=<path>] tags", () => {
    // Given: mediaTagFor called with each of the 8 field names + a localPath
    // When: tag returned for each
    // Then: photo→[TG_PHOTO=<path>], voice→[TG_VOICE=<path>], document→[TG_DOCUMENT=<path>],
    //       audio→[TG_AUDIO=<path>], video→[TG_VIDEO=<path>], video_note→[TG_VIDEONOTE=<path>],
    //       sticker→[TG_STICKER=<path>], animation→[TG_ANIMATION=<path>]
    const localPath = "/tmp/test.jpg";
    const expected: Record<string, string> = {
      photo: `[TG_PHOTO=${localPath}]`,
      voice: `[TG_VOICE=${localPath}]`,
      document: `[TG_DOCUMENT=${localPath}]`,
      audio: `[TG_AUDIO=${localPath}]`,
      video: `[TG_VIDEO=${localPath}]`,
      video_note: `[TG_VIDEONOTE=${localPath}]`,
      sticker: `[TG_STICKER=${localPath}]`,
      animation: `[TG_ANIMATION=${localPath}]`,
    };
    for (const [field, expectedTag] of Object.entries(expected)) {
      const tag = mediaTagFor(field, localPath);
      assert.equal(tag, expectedTag, `mediaTagFor("${field}", path) must return "${expectedTag}"; got: "${tag}"`);
    }
  });

  it("T-Inbox.6: 5-param — when getFile returns { ok:false }, throws with message containing 'getFile failed' and the error JSON", async () => {
    // Given: transport getFile returns { ok:false, description:"FILE_REFERENCE_EXPIRED" }
    // When: downloadTelegramFile called
    // Then: throws; error message contains "getFile failed" + description or JSON
    const { root, cleanup } = makeTmpRoot();
    try {
      const transport: Transport = async (url) => {
        if (url.includes("/getFile")) {
          return {
            ok: true,
            json: async () => ({ ok: false, description: "FILE_REFERENCE_EXPIRED" }),
          } as unknown as Response;
        }
        return {
          ok: true,
          arrayBuffer: async () => Buffer.alloc(0).buffer,
          headers: { get: () => null },
        } as unknown as Response;
      };

      await assert.rejects(
        () => downloadTelegramFile("tok", "fid", "funiq", root, transport),
        (err: Error) => {
          assert.ok(
            err.message.includes("getFile failed"),
            `error must contain "getFile failed"; got: "${err.message}"`,
          );
          assert.ok(
            err.message.includes("FILE_REFERENCE_EXPIRED") || err.message.includes("ok"),
            `error must include description or JSON; got: "${err.message}"`,
          );
          return true;
        },
      );
    } finally {
      cleanup();
    }
  });

  it("T-Inbox.7: 5-param — when binary download returns HTTP 404, throws with message containing the HTTP status; does NOT silently write a 0-byte file", async () => {
    // Given: getFile ok; binary download returns { ok:false, status:404 }
    // When: downloadTelegramFile called
    // Then: throws; error mentions HTTP 404; no file written at localPath
    const { root, cleanup } = makeTmpRoot();
    try {
      const transport: Transport = async (url) => {
        if (url.includes("/getFile")) {
          return {
            ok: true,
            json: async () => ({ ok: true, result: { file_path: "photos/img.jpg", file_size: 1000 } }),
          } as unknown as Response;
        }
        // Binary download: 404
        return {
          ok: false,
          status: 404,
          arrayBuffer: async () => Buffer.alloc(0).buffer,
          headers: { get: () => null },
        } as unknown as Response;
      };

      await assert.rejects(
        () => downloadTelegramFile("tok", "fid", "funiq", root, transport),
        (err: Error) => {
          assert.ok(
            err.message.includes("404") || err.message.includes("binary download"),
            `error must mention HTTP 404 or binary download; got: "${err.message}"`,
          );
          return true;
        },
      );

      // Verify no file was written (telegram-inbox dir might not even exist)
      const inboxDir = join(root, "telegram-inbox");
      if (existsSync(inboxDir)) {
        const files = readdirSync(inboxDir);
        assert.equal(files.length, 0, "telegram-inbox must be empty — no 0-byte file written on 404");
      }
    } finally {
      cleanup();
    }
  });
});
