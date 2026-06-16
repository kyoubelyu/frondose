/**
 * P-6 / P-11: telegram_notify Vercel tool.
 *
 * P-11 D-5/D-15/D-21/D-22/D-24: extended outbound surface — text, media (photo/audio/
 * video/voice/document/animation/video_note/sticker), media group (album), structural
 * controls (edit/delete/pin/unpin/sendChatAction), and inline replyMarkup. All extension
 * fields are optional (backward-compat per scout F-9). Mutual exclusivity is checked
 * at runtime (D-22) and returns `fail("invalid_input", ...)` envelope (NOT thrown).
 *
 * Transport: P-11 routes via `telegramFetch` (undici Agent + fallback IP / ProxyAgent).
 *
 * No `child_process` import (lint-enforced under src/tools/**); fetch + tls only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";
import { assertFileReadable } from "../../linkedin/uploadAllowlist.js";
import { telegramFetch } from "../telegram/transport.js";

const SEVERITY_EMOJI: Record<string, string> = {
  info: "ℹ️",
  warning: "⚠️",
  error: "🚨",
};

const MEDIA_TYPES = ["photo", "audio", "video", "voice", "document", "animation", "video_note", "sticker"] as const;

const telegramParams = z.object({
  body: z
    .string()
    .min(1)
    .max(4000)
    .describe("Message body / caption (≤ 4000 chars; Telegram caps at 4096 with prefix)."),
  severity: z.enum(["info", "warning", "error"]).default("info").describe("Severity prefix."),
  parseMode: z.enum(["HTML", "Markdown", "MarkdownV2"]).optional().describe("Optional Telegram parse mode."),
  // P-11 D-5: media surface (additive, optional). Exactly one of mediaPath/mediaFileId/mediaUrl
  // when mediaType set (D-22 runtime check).
  mediaType: z
    .enum(MEDIA_TYPES)
    .optional()
    .describe("Outbound media type (one of photo/audio/video/voice/document/animation/video_note/sticker)."),
  mediaPath: z
    .string()
    .optional()
    .describe("Local file path (multipart upload; must be FRONDOSE_UPLOAD_ALLOWLIST-readable)."),
  mediaFileId: z.string().optional().describe("Reuse a previously-uploaded Telegram file_id."),
  mediaUrl: z.string().url().optional().describe("Public HTTPS URL Telegram fetches directly."),
  mediaGroup: z
    .array(
      z.object({
        type: z.enum(["photo", "video", "audio", "document"]),
        media: z.string(),
        caption: z.string().optional(),
      }),
    )
    .min(2)
    .max(10)
    .optional()
    .describe(
      "Album: 2-10 InputMedia items (sendMediaGroup). For local-file items, set media to a local path; tool builds attach:// references.",
    ),
  // P-11 D-5: structural controls (additive, optional). At most one per call (D-22).
  editMessageId: z.number().int().positive().optional().describe("editMessageText target."),
  deleteMessageId: z.number().int().positive().optional().describe("deleteMessage target."),
  pinMessageId: z.number().int().positive().optional().describe("pinChatMessage target."),
  unpinMessageId: z.number().int().positive().optional().describe("unpinChatMessage target (omit to unpin all)."),
  chatAction: z
    .enum([
      "typing",
      "upload_photo",
      "record_video",
      "upload_video",
      "record_voice",
      "upload_voice",
      "upload_document",
      "choose_sticker",
      "find_location",
      "record_video_note",
      "upload_video_note",
    ])
    .optional()
    .describe("sendChatAction value (typing indicator etc.)."),
  // P-11 D-15: replyMarkup outbound only.
  replyMarkup: z
    .string()
    .optional()
    .describe("JSON-encoded InlineKeyboardMarkup string; forwarded to Bot API as reply_markup."),
});

// biome-ignore lint/complexity/noBannedTypes: placeholder for future per-channel routing config (plan §6.1).
export type TelegramOpts = {};

type TelegramParams = z.infer<typeof telegramParams>;

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".webm": "video/webm",
};

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function isLocalMediaPath(media: string): boolean {
  if (/^https?:\/\//i.test(media)) return false;
  return path.isAbsolute(media) || path.win32.isAbsolute(media) || media.includes("/") || media.includes("\\");
}

/** D-22: return-style mutual-exclusivity check. Returns null if OK; otherwise an error message. */
function validateExclusivity(p: TelegramParams): string | null {
  const errs: string[] = [];
  // Media-source exclusivity (only relevant when mediaType is set)
  if (p.mediaType) {
    const sources = [p.mediaPath, p.mediaFileId, p.mediaUrl].filter((x) => x !== undefined && x !== "");
    if (sources.length === 0) {
      errs.push("When mediaType is set, exactly one of mediaPath / mediaFileId / mediaUrl must be provided.");
    } else if (sources.length > 1) {
      errs.push("mediaPath, mediaFileId, and mediaUrl are mutually exclusive — provide exactly one.");
    }
  }
  // Structural-control exclusivity: at most one of edit/delete/pin/unpin/chatAction/mediaGroup/mediaType
  const structural = [
    p.editMessageId !== undefined,
    p.deleteMessageId !== undefined,
    p.pinMessageId !== undefined,
    p.unpinMessageId !== undefined,
    p.chatAction !== undefined,
    p.mediaGroup !== undefined,
    p.mediaType !== undefined,
  ].filter(Boolean).length;
  if (structural > 1) {
    errs.push(
      "at most one structural-control field per call (mediaType, mediaGroup, editMessageId, deleteMessageId, pinMessageId, unpinMessageId, chatAction).",
    );
  }
  return errs.length === 0 ? null : errs.join(" ");
}

interface RouteResult {
  url: string;
  init: RequestInit;
}

/** Build a multipart body for a single-media send (sendPhoto / sendVideo / etc.). */
function buildSingleMediaMultipart(
  mediaType: string,
  filePath: string,
  chatId: string,
  caption: string,
  parseMode: string | undefined,
  replyMarkup: string | undefined,
): FormData {
  assertFileReadable(filePath);
  const bytes = readFileSync(filePath);
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeFor(filePath) });
  const fd = new FormData();
  fd.set("chat_id", chatId);
  fd.set(mediaType, blob, path.basename(filePath));
  if (caption) fd.set("caption", caption);
  if (parseMode) fd.set("parse_mode", parseMode);
  if (replyMarkup) fd.set("reply_markup", replyMarkup);
  return fd;
}

/** sendMediaGroup multipart: builds attach:// references for local-path items. */
function buildMediaGroupMultipart(group: NonNullable<TelegramParams["mediaGroup"]>, chatId: string): FormData {
  const fd = new FormData();
  fd.set("chat_id", chatId);
  // Build the JSON media array; replace local paths with attach://mediaN references.
  const mediaArr = group.map((item, i) => {
    const isLocal = isLocalMediaPath(item.media);
    if (isLocal) {
      assertFileReadable(item.media);
      const bytes = readFileSync(item.media);
      const blob = new Blob([new Uint8Array(bytes)], { type: mimeFor(item.media) });
      const partName = `media${i}`;
      fd.set(partName, blob, path.basename(item.media));
      return { type: item.type, media: `attach://${partName}`, ...(item.caption ? { caption: item.caption } : {}) };
    }
    return { type: item.type, media: item.media, ...(item.caption ? { caption: item.caption } : {}) };
  });
  fd.set("media", JSON.stringify(mediaArr));
  return fd;
}

/** Decide which Bot API method + body shape to use based on params. Body=text already prefixed with severity emoji upstream. */
function routeRequest(p: TelegramParams, token: string, chatId: string, captionOrText: string): RouteResult {
  const base = `https://api.telegram.org/bot${token}`;
  const replyMarkupObj = p.replyMarkup ? safeParseJson(p.replyMarkup) : undefined;
  const jsonInit = (payload: Record<string, unknown>): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  // Structural-control branches first (they don't accept media).
  if (p.editMessageId !== undefined) {
    const payload: Record<string, unknown> = { chat_id: chatId, message_id: p.editMessageId, text: captionOrText };
    if (p.parseMode) payload.parse_mode = p.parseMode;
    if (replyMarkupObj !== undefined) payload.reply_markup = replyMarkupObj;
    return { url: `${base}/editMessageText`, init: jsonInit(payload) };
  }
  if (p.deleteMessageId !== undefined) {
    return { url: `${base}/deleteMessage`, init: jsonInit({ chat_id: chatId, message_id: p.deleteMessageId }) };
  }
  if (p.pinMessageId !== undefined) {
    return { url: `${base}/pinChatMessage`, init: jsonInit({ chat_id: chatId, message_id: p.pinMessageId }) };
  }
  if (p.unpinMessageId !== undefined) {
    return { url: `${base}/unpinChatMessage`, init: jsonInit({ chat_id: chatId, message_id: p.unpinMessageId }) };
  }
  if (p.chatAction !== undefined) {
    return { url: `${base}/sendChatAction`, init: jsonInit({ chat_id: chatId, action: p.chatAction }) };
  }
  if (p.mediaGroup !== undefined) {
    return {
      url: `${base}/sendMediaGroup`,
      init: { method: "POST", body: buildMediaGroupMultipart(p.mediaGroup, chatId) },
    };
  }
  if (p.mediaType !== undefined) {
    const method = `send${p.mediaType
      .split("_")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join("")}`;
    if (p.mediaPath !== undefined) {
      return {
        url: `${base}/${method}`,
        init: {
          method: "POST",
          body: buildSingleMediaMultipart(p.mediaType, p.mediaPath, chatId, captionOrText, p.parseMode, p.replyMarkup),
        },
      };
    }
    // exclusivity already validated by validateExclusivity → at least one of mediaFileId/mediaUrl set
    const ref = p.mediaFileId ?? p.mediaUrl ?? "";
    const payload: Record<string, unknown> = { chat_id: chatId, [p.mediaType]: ref };
    if (captionOrText) payload.caption = captionOrText;
    if (p.parseMode) payload.parse_mode = p.parseMode;
    if (replyMarkupObj !== undefined) payload.reply_markup = replyMarkupObj;
    return { url: `${base}/${method}`, init: jsonInit(payload) };
  }
  // Default: sendMessage (existing behavior, backward-compat).
  const payload: Record<string, unknown> = { chat_id: chatId, text: captionOrText };
  if (p.parseMode) payload.parse_mode = p.parseMode;
  if (replyMarkupObj !== undefined) payload.reply_markup = replyMarkupObj;
  return { url: `${base}/sendMessage`, init: jsonInit(payload) };
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * Build the telegram_notify Vercel tool. Sends a single message (or media / control)
 * to the operator's Telegram channel via Bot API. Reads TELEGRAM_TOKEN + TELEGRAM_CHAT_ID
 * from process.env on first execute. Graceful degradation when env unset.
 *
 * No `child_process` import (lint-enforced under src/tools/**); pure native fetch.
 */
export function makeTelegramNotifyTool(_opts: TelegramOpts = {}) {
  return tool({
    description:
      "Send a notification, media (photo/audio/video/voice/document/animation/video_note/sticker), media group (album), " +
      "or structural control (edit/delete/pin/unpin/sendChatAction) to the operator's Telegram channel. " +
      "Severity prefix (ℹ️ info / ⚠️ warning / 🚨 error) goes before text/caption. " +
      "Use for: 'capability gap', 'task complete', 'LinkedIn surface changed unexpectedly', or any operator-attention-requiring event. " +
      "Returns the Telegram message_id on success.",
    parameters: telegramParams,
    execute: async (params) => {
      try {
        const token = process.env.TELEGRAM_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!token) {
          return {
            ok: false,
            command: "telegram_notify",
            error: { kind: "runtime_error", message: "TELEGRAM_TOKEN is not set; notification not sent." },
          };
        }
        if (!chatId) {
          return {
            ok: false,
            command: "telegram_notify",
            error: { kind: "runtime_error", message: "TELEGRAM_CHAT_ID is not set; notification not sent." },
          };
        }
        // P-11 D-22: runtime mutual-exclusivity check.
        const exclusivityErr = validateExclusivity(params);
        if (exclusivityErr) {
          return {
            ok: false,
            command: "telegram_notify",
            error: { kind: "invalid_input", message: exclusivityErr },
          };
        }
        const emoji = SEVERITY_EMOJI[params.severity] ?? "ℹ️";
        const decorated = `${emoji} ${params.body}`;
        const route = routeRequest(params, token, chatId, decorated);
        // Endpoint embeds token in URL path per Telegram Bot API spec.
        // The token is NEVER logged in audit (audit records params only, not URL).
        const response = await telegramFetch(route.url, route.init);

        if (!response.ok) {
          let detail = `HTTP ${response.status}`;
          try {
            const errBody = (await response.json()) as { description?: string };
            if (errBody.description) detail += `: ${errBody.description}`;
          } catch {
            // ignore JSON parse failure; HTTP status is sufficient
          }
          return {
            ok: false,
            command: "telegram_notify",
            error: {
              kind: response.status === 401 ? "invalid_input" : "runtime_error",
              message: `Telegram API error: ${detail}`,
            },
          };
        }

        // sendMediaGroup returns { ok, result: Message[] } — pick the first message_id.
        // editMessageText/deleteMessage/pin/unpin/sendChatAction return { ok, result: true|Message } variably.
        const result = (await response.json()) as {
          ok: boolean;
          result?: { message_id: number } | Array<{ message_id: number }> | boolean;
        };
        if (!result.ok) {
          return {
            ok: false,
            command: "telegram_notify",
            error: { kind: "runtime_error", message: "Telegram API returned ok:false." },
          };
        }
        let messageId: number | null = null;
        if (Array.isArray(result.result) && result.result.length > 0) {
          messageId = result.result[0]?.message_id ?? null;
        } else if (typeof result.result === "object" && result.result !== null && "message_id" in result.result) {
          messageId = result.result.message_id;
        }
        return ok("telegram_notify", { messageId, severity: params.severity });
      } catch (e) {
        return failFromError("telegram_notify", e);
      }
    },
  });
}
