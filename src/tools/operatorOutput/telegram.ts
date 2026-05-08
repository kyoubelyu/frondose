import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";

const SEVERITY_EMOJI: Record<string, string> = {
  info: "ℹ️",
  warning: "⚠️",
  error: "🚨",
};

const telegramParams = z.object({
  body: z.string().min(1).max(4000).describe("Message body (≤ 4000 chars; Telegram caps at 4096 with prefix)."),
  severity: z.enum(["info", "warning", "error"]).default("info").describe("Severity prefix."),
  parseMode: z.enum(["HTML", "Markdown", "MarkdownV2"]).optional().describe("Optional Telegram parse mode."),
});

// biome-ignore lint/complexity/noBannedTypes: placeholder for future per-channel routing config (plan §6.1).
export type TelegramOpts = {};

/**
 * Build the telegram_notify Vercel tool. Sends a single message to the operator's
 * Telegram channel via Bot API. Reads TELEGRAM_TOKEN + TELEGRAM_CHAT_ID from
 * process.env on first execute. Graceful degradation when env unset.
 *
 * No `child_process` import (lint-enforced under src/tools/**); pure native fetch.
 */
export function makeTelegramNotifyTool(_opts: TelegramOpts = {}) {
  return tool({
    description:
      "Send a single notification to the operator's Telegram channel. " +
      "Severity prefix (ℹ️ info / ⚠️ warning / 🚨 error) goes before the body. " +
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
        const emoji = SEVERITY_EMOJI[params.severity] ?? "ℹ️";
        const text = `${emoji} ${params.body}`;
        // Endpoint embeds token in URL path per Telegram Bot API spec.
        // The token is NEVER logged in audit (audit records params only, not URL).
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        const payload: Record<string, unknown> = { chat_id: chatId, text };
        if (params.parseMode) payload.parse_mode = params.parseMode;

        const response = await globalThis.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

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

        const result = (await response.json()) as { ok: boolean; result?: { message_id: number } };
        if (!result.ok || !result.result) {
          return {
            ok: false,
            command: "telegram_notify",
            error: { kind: "runtime_error", message: "Telegram API returned ok:false or missing result." },
          };
        }
        return ok("telegram_notify", { messageId: result.result.message_id, severity: params.severity });
      } catch (e) {
        return failFromError("telegram_notify", e);
      }
    },
  });
}
