/**
 * P-11 / D-1 / D-7 / D-8 / D-19 / D-20: bidirectional Telegram REPL integration.
 * P-23 §6.4: daemon-mode poller `startDaemonPoller` added alongside the existing
 *   REPL-mode poller; gated on `repl.pid` (offset pinned while REPL is alive)
 *   and on cross-process `turn.lock` (LockBusy → defer, no offset advance).
 *
 * Exports:
 *   - startTelegramPoller(cfg, deps, turnLock, abort): REPL-mode poller
 *   - startDaemonPoller(cfg, deps, turnLock, abort): P-23 daemon-mode poller
 *   - handleTelegramSlash(line, ctx): /telegram on|off|status REPL slash dispatcher
 *   - handleTelegramTurn(update, deps): inject inbound message → run loop → auto-push reply
 *   - sendTelegramMessage(token, chatId, text, transport): outbound helper for auto-reply
 *
 * BLOCKER-1 fix locked: abort guard between turnLock release and offset write.
 */
import os from "node:os";
import path from "node:path";
import type { CoreMessage, LanguageModel, StepResult, ToolSet } from "ai";
import { runAgentLoop } from "../agent/loop.js";
import type { TurnLock } from "../agent/turnSemaphore.js";
import { acquireTurnLock, isPidAlive, releaseTurnLock } from "../persistence/processLock.js";
import { appendMessages as appendMessagesPerCwd } from "../persistence/session.js";
import { readTelegramConfig, type TelegramConfig, writeTelegramConfig } from "../persistence/telegramConfig.js";
import { downloadTelegramFile, mediaTagFor } from "../tools/telegram/inboundMedia.js";
import { telegramFetch } from "../tools/telegram/transport.js";

const TRUNCATION_SUFFIX = "… (truncated; see REPL or session log for full response)";
const MAX_REPLY_BODY = 4000;

export interface PollerHandle {
  running: boolean;
  offset: number;
  lastPollAt: string | null;
  /** P-12 D-5: wire-level last-received timestamp; null until first update arrives. */
  lastReceivedAt: string | null;
  abort: AbortController;
}

export interface TelegramTurnDeps {
  model: LanguageModel;
  system: string;
  messages: CoreMessage[];
  tools: ToolSet;
  /** P-12 D-1: object reference (was: string) — survives `/new` mid-poller rotation. */
  sessionFile: { path: string };
  abortSignal?: AbortSignal;
  onStepFinish?: (step: StepResult<ToolSet>) => Promise<void> | void;
  out: NodeJS.WritableStream;
  /** P-46 D-1b: agent-loop step budget. Undefined → loop default (200). */
  maxSteps?: number;
  configPath: string;
  uploadAllowlistRoot: string;
  /** P-23 §6.7: pluggable session-append writer.
   *  REPL injects per-cwd `appendMessages`; daemon injects `appendMessagesShared`.
   *  Default = per-cwd `appendMessages` (preserves P-11/P-12 callers). */
  appendMessages?: (file: string, messages: CoreMessage[]) => void;
  /** P-26 Step-5a B-26R-1: optional pre-turn prefix injection. Server daemon
   *  supplies `drainServerInbox(serverInboxDb)`; worker telegram daemon leaves
   *  undefined. When defined and returns non-null, the result is prepended to
   *  the user message with a "\n\n---\n\n" separator BEFORE `runAgentLoop`,
   *  so the server LLM sees fleet events as context. */
  inboxPrefix?: () => string | null;
}

interface TelegramFileRef {
  file_id: string;
  file_unique_id: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    caption?: string;
    from?: { username?: string; id: number };
    photo?: TelegramFileRef[];
    voice?: TelegramFileRef;
    document?: TelegramFileRef;
    audio?: TelegramFileRef;
    video?: TelegramFileRef;
    video_note?: TelegramFileRef;
    sticker?: TelegramFileRef;
    animation?: TelegramFileRef;
  };
}

const MEDIA_FIELDS = ["photo", "voice", "document", "audio", "video", "video_note", "sticker", "animation"] as const;

/** Slash dispatcher context: minimal subset surfaced from SlashCtx for /telegram handler. */
export interface TelegramSlashCtx {
  out: NodeJS.WritableStream;
  configPath: string;
  /** Mutable poller-handle state; null when not running. */
  pollerHandle: PollerHandle | null;
  /** Setter so /telegram on can attach a freshly-started poller back into ctx. */
  onPollerStart: (handle: PollerHandle | null) => void;
  /** Deps + lock needed when /telegram on must boot a poller in-place. */
  turnLock: TurnLock;
  deps: TelegramTurnDeps;
}

/** D-7 + D-19: fire-and-forget poller. Exits on abort. */
export async function startTelegramPoller(
  cfg: TelegramConfig,
  deps: TelegramTurnDeps,
  turnLock: TurnLock,
  abort: AbortController,
): Promise<PollerHandle> {
  const handle: PollerHandle = {
    running: true,
    offset: cfg.lastUpdateOffset,
    lastPollAt: null,
    // P-12 D-5: restore lastReceivedAt from cfg on poller restart (forward-compat: null).
    lastReceivedAt: cfg.lastReceivedAt ?? null,
    abort,
  };
  // Fire-and-forget loop
  void (async () => {
    const token = process.env.TELEGRAM_TOKEN;
    if (!token) {
      deps.out.write("[telegram] poller cannot start: TELEGRAM_TOKEN unset\n");
      handle.running = false;
      return;
    }
    while (!abort.signal.aborted) {
      try {
        const url = `https://api.telegram.org/bot${token}/getUpdates`;
        const body = JSON.stringify({
          offset: handle.offset,
          timeout: cfg.pollTimeoutSec,
          allowed_updates: ["message"], // D-23
        });
        const res = await telegramFetch(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          },
          {
            signal: abort.signal,
            fallbackIp: cfg.stickyFallbackIp ?? undefined,
            proxyUrl: process.env.TELEGRAM_PROXY ?? cfg.proxyUrl ?? undefined,
            onFallbackSuccess: (ip) => {
              cfg.stickyFallbackIp = ip;
              writeTelegramConfig(cfg, deps.configPath);
            },
          },
        );
        const j = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
        handle.lastPollAt = new Date().toISOString();
        for (const upd of j.result ?? []) {
          if (abort.signal.aborted) break;
          // P-12 D-5 (Option C): record wire-level receive timestamp BEFORE turnLock.run
          // so it advances even if handleTelegramTurn drops the update (wrong sender /
          // empty message). The wire DID receive the update — that is what advances.
          handle.lastReceivedAt = new Date().toISOString();
          await turnLock.run(() => handleTelegramTurn(upd, deps));
          // BLOCKER-1 fix: abort guard BEFORE the offset write. Without this, /telegram off
          // acquired between handleTelegramTurn release and writeTelegramConfig would have
          // its `enabled=false` overwritten by the poller's local cfg copy. See R-12.
          if (abort.signal.aborted) break;
          handle.offset = upd.update_id + 1;
          cfg.lastUpdateOffset = handle.offset;
          // P-12 D-5: mirror handle → cfg before existing write; lands in telegram.json atomically.
          cfg.lastReceivedAt = handle.lastReceivedAt;
          writeTelegramConfig(cfg, deps.configPath);
        }
      } catch (e) {
        if (abort.signal.aborted) break;
        deps.out.write(`[telegram] poll error: ${e instanceof Error ? e.message : String(e)}\n`);
        await new Promise((r) => setTimeout(r, cfg.pollBackoffSec * 1000));
      }
    }
    handle.running = false;
  })();
  return handle;
}

/** D-20: inject update as user turn → run loop → auto-push reply (NOT via telegram_notify). */
export async function handleTelegramTurn(update: TelegramUpdate, deps: TelegramTurnDeps): Promise<void> {
  const msg = update.message;
  if (!msg) {
    deps.out.write(`[telegram] (unsupported update kind ${update.update_id})\n`);
    return;
  }
  const cfg = readTelegramConfig(deps.configPath);
  // v0.4.6: DM-only authorization — drop messages from any sender other than the bound user.
  // Prevents bot from processing strangers' messages (LLM waste + auth surface).
  const fromId = msg.from?.id;
  if (cfg.boundUserId !== null && fromId !== cfg.boundUserId) {
    deps.out.write(
      `[telegram] dropped update ${update.update_id} from user ${fromId ?? "?"} (not bound user ${cfg.boundUserId})\n`,
    );
    return;
  }
  const username = msg.from?.username ?? `id${msg.from?.id ?? "?"}`;
  const lines: string[] = [`[TG_FROM=${username}]`];
  const token = process.env.TELEGRAM_TOKEN;
  // Handle media → download + tag
  if (token) {
    for (const field of MEDIA_FIELDS) {
      const v = (msg as unknown as Record<string, unknown>)[field];
      if (!v) continue;
      // photo is an array; pick the largest (last) per Telegram API convention
      const fileObj = field === "photo" ? (v as TelegramFileRef[]).at(-1) : (v as TelegramFileRef);
      if (!fileObj?.file_id) continue;
      try {
        const { localPath } = await downloadTelegramFile(
          token,
          fileObj.file_id,
          fileObj.file_unique_id,
          deps.uploadAllowlistRoot,
          (u, init) =>
            telegramFetch(u, init, {
              fallbackIp: cfg.stickyFallbackIp ?? undefined,
              proxyUrl: process.env.TELEGRAM_PROXY ?? cfg.proxyUrl ?? undefined,
            }),
        );
        lines.push(mediaTagFor(field, localPath));
      } catch (e) {
        lines.push(`[TG_${field.toUpperCase()}_ERROR=${e instanceof Error ? e.message : String(e)}]`);
      }
    }
  }
  const textBody = msg.text ?? msg.caption ?? "";
  if (textBody) lines.push(textBody);
  if (lines.length === 1) {
    // only header — nothing to actually inject
    deps.out.write(`[telegram] (empty message ${update.update_id})\n`);
    return;
  }
  // P-12 D-4: visibility — operator sees inbound message before agent loop runs.
  // OQ-6: media-only messages (textBody === "") use lines[1] (first media tag) as preview source.
  const previewSource = textBody !== "" ? textBody : (lines[1] ?? "");
  const inPreview = previewSource.length > 80 ? `${previewSource.slice(0, 80)}…` : previewSource;
  deps.out.write(`[telegram] ↓ @${username}: ${inPreview}\n`);

  const turnStart = deps.messages.length;
  // P-26 Step-5a B-26R-1: server daemon supplies `inboxPrefix`; worker daemon
  // leaves it undefined. When supplied + non-null, prepend the formatted
  // pending-events summary so the server LLM sees fleet activity as context.
  const prefix = deps.inboxPrefix?.() ?? null;
  const userContent = prefix ? `${prefix}\n\n---\n\n${lines.join("\n")}` : lines.join("\n");
  deps.messages.push({ role: "user", content: userContent });
  await runAgentLoop({
    model: deps.model,
    system: deps.system,
    messages: deps.messages,
    tools: deps.tools,
    maxSteps: deps.maxSteps, // P-46 D-1b
    abortSignal: deps.abortSignal,
    onStepFinish: deps.onStepFinish,
  });
  if (deps.abortSignal?.aborted) return;
  const tail = deps.messages.slice(turnStart);
  // P-12 D-1: dereference at use site; deps.sessionFile is now { path: string } (mutable ref).
  // P-23 §6.7: writer is pluggable via deps.appendMessages (daemon → appendMessagesShared).
  (deps.appendMessages ?? appendMessagesPerCwd)(deps.sessionFile.path, tail);
  // D-20 + D-24: auto-push reply (bypass telegram_notify tool); truncate at 4000 chars.
  const finalText = extractAssistantText(tail);
  if (finalText && token) {
    const truncated =
      finalText.length > MAX_REPLY_BODY ? `${finalText.slice(0, MAX_REPLY_BODY)}${TRUNCATION_SUFFIX}` : finalText;
    const chatId = cfg.boundUserId;
    if (chatId !== null) {
      try {
        await sendTelegramMessage(token, chatId, truncated, (u, init) =>
          telegramFetch(u, init, {
            fallbackIp: cfg.stickyFallbackIp ?? undefined,
            proxyUrl: process.env.TELEGRAM_PROXY ?? cfg.proxyUrl ?? undefined,
          }),
        );
        // P-12 D-4: visibility — operator sees the outbound reply after sendTelegramMessage succeeds.
        const outPreview = truncated.length > 80 ? `${truncated.slice(0, 80)}…` : truncated;
        deps.out.write(`[telegram] ↑ @${username}: ${outPreview}\n`);
      } catch (e) {
        deps.out.write(`[telegram] auto-reply send failed: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
  }
}

/** D-20: outbound helper for the auto-reply path; intentionally NOT audited. */
export async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
  transport: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await transport(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

/** D-8: /telegram on|off|status REPL slash dispatcher. */
export async function handleTelegramSlash(line: string, ctx: TelegramSlashCtx): Promise<void> {
  const tokens = line.trim().split(/\s+/);
  // tokens[0] === "/telegram"; verb is tokens[1]
  const verb = tokens[1];
  const cfg = readTelegramConfig(ctx.configPath);
  if (verb === undefined || verb === "") {
    ctx.out.write("/telegram: usage — /telegram on | off | status\n");
    return;
  }
  if (verb === "status") {
    ctx.out.write(`[telegram] enabled: ${cfg.enabled}\n`);
    ctx.out.write(`[telegram] boundUserId: ${cfg.boundUserId ?? "(unset)"}\n`);
    ctx.out.write(`[telegram] lastUpdateOffset: ${cfg.lastUpdateOffset}\n`);
    // P-12 D-5: surface wire-level last-received timestamp.
    ctx.out.write(`[telegram] lastReceivedAt: ${cfg.lastReceivedAt ?? "(none)"}\n`);
    ctx.out.write(`[telegram] stickyFallbackIp: ${cfg.stickyFallbackIp ?? "(none)"}\n`);
    ctx.out.write(`[telegram] running: ${ctx.pollerHandle?.running === true}\n`);
    return;
  }
  if (verb === "on") {
    if (!process.env.TELEGRAM_TOKEN) {
      ctx.out.write("/telegram on: set TELEGRAM_TOKEN env var first; poller not started.\n");
      return;
    }
    if (cfg.boundUserId === null) {
      ctx.out.write(
        "/telegram on: no boundUserId — run `/telegram bind <user_id>` (or `mai telegram bind <user_id>`) first.\n",
      );
      return;
    }
    cfg.enabled = true;
    writeTelegramConfig(cfg, ctx.configPath);
    if (ctx.pollerHandle?.running === true) {
      ctx.out.write("[telegram] already running\n");
      return;
    }
    const abort = new AbortController();
    const handle = await startTelegramPoller(cfg, ctx.deps, ctx.turnLock, abort);
    ctx.onPollerStart(handle);
    ctx.out.write("[telegram] enabled — poller started\n");
    return;
  }
  if (verb === "off") {
    cfg.enabled = false;
    writeTelegramConfig(cfg, ctx.configPath);
    if (ctx.pollerHandle) {
      ctx.pollerHandle.abort.abort();
      ctx.onPollerStart(null);
    }
    ctx.out.write("[telegram] disabled\n");
    return;
  }
  ctx.out.write(`/telegram: unknown verb "${verb}" — valid: on | off | status\n`);
}

/** P-23 §6.4: daemon-mode poller with REPL-pause + cross-process turn-lock gates.
 *  Two gates per update:
 *    (1) C1 BLOCKER fix — while `repl.pid` is alive, defer turn AND do NOT
 *        advance offset (Telegram redelivers buffered updates after REPL exits).
 *    (2) C2 CONCERN-MR fix — acquire cross-process `acquireTurnLock(turn.lock)`
 *        before invoking the in-process `turnLock.run(handleTelegramTurn)`. On
 *        LockBusy, log + defer + offset unchanged. */
export async function startDaemonPoller(
  cfg: TelegramConfig,
  deps: TelegramTurnDeps,
  turnLock: TurnLock,
  abort: AbortController,
): Promise<PollerHandle> {
  const handle: PollerHandle = {
    running: true,
    offset: cfg.lastUpdateOffset,
    lastPollAt: null,
    lastReceivedAt: cfg.lastReceivedAt ?? null,
    abort,
  };
  const replPidPath = path.join(os.homedir(), ".mai", "agent", "repl.pid");
  const turnLockPath = path.join(os.homedir(), ".mai", "agent", "turn.lock");
  void (async () => {
    const token = process.env.TELEGRAM_TOKEN;
    if (!token) {
      deps.out.write("[telegram daemon] cannot start: TELEGRAM_TOKEN unset\n");
      handle.running = false;
      return;
    }
    while (!abort.signal.aborted) {
      try {
        const url = `https://api.telegram.org/bot${token}/getUpdates`;
        const body = JSON.stringify({
          offset: handle.offset,
          timeout: cfg.pollTimeoutSec,
          allowed_updates: ["message"],
        });
        const res = await telegramFetch(
          url,
          { method: "POST", headers: { "Content-Type": "application/json" }, body },
          {
            signal: abort.signal,
            fallbackIp: cfg.stickyFallbackIp ?? undefined,
            proxyUrl: process.env.TELEGRAM_PROXY ?? cfg.proxyUrl ?? undefined,
            onFallbackSuccess: (ip) => {
              cfg.stickyFallbackIp = ip;
              writeTelegramConfig(cfg, deps.configPath);
            },
          },
        );
        const j = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
        handle.lastPollAt = new Date().toISOString();
        for (const upd of j.result ?? []) {
          if (abort.signal.aborted) break;
          handle.lastReceivedAt = new Date().toISOString();
          // Gate 1 (C1 fix): REPL alive → defer + offset UNCHANGED.
          if (isPidAlive(replPidPath)) {
            deps.out.write(
              `[telegram daemon] REPL active — deferring update ${upd.update_id} (offset NOT advanced; will redeliver)\n`,
            );
            continue;
          }
          // Gate 2 (C2 fix): cross-process turn lock around handleTelegramTurn.
          let xLock: Awaited<ReturnType<typeof acquireTurnLock>>;
          try {
            xLock = await acquireTurnLock(turnLockPath, "daemon-tg", { timeoutMs: 60_000 });
          } catch (e) {
            // LockBusy → REPL is running a turn; defer (no offset advance).
            deps.out.write(
              `[telegram daemon] turn.lock busy (${e instanceof Error ? e.message : String(e)}); deferring update ${upd.update_id}\n`,
            );
            continue;
          }
          try {
            await turnLock.run(() => handleTelegramTurn(upd, deps));
          } finally {
            releaseTurnLock(xLock);
          }
          if (abort.signal.aborted) break;
          // Offset advance + persist ONLY when the turn was actually executed.
          handle.offset = upd.update_id + 1;
          cfg.lastUpdateOffset = handle.offset;
          cfg.lastReceivedAt = handle.lastReceivedAt;
          writeTelegramConfig(cfg, deps.configPath);
        }
      } catch (e) {
        if (abort.signal.aborted) break;
        deps.out.write(`[telegram daemon] poll error: ${e instanceof Error ? e.message : String(e)}\n`);
        await new Promise((r) => setTimeout(r, cfg.pollBackoffSec * 1000));
      }
    }
    handle.running = false;
  })();
  return handle;
}

function extractAssistantText(turnMessages: CoreMessage[]): string {
  for (let i = turnMessages.length - 1; i >= 0; i--) {
    const m = turnMessages[i];
    if (m?.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const parts = m.content as Array<{ type: string; text?: string }>;
      return parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("");
    }
  }
  return "";
}
