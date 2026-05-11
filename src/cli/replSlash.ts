import type { CoreMessage, LanguageModel } from "ai";
import { compactMessages } from "../agent/compaction.js";
import type { TokenBudget } from "../agent/tokenBudget.js";
import type { TurnLock } from "../agent/turnSemaphore.js";
import { newSessionFile, rewriteSession, writeCompactionMarker } from "../persistence/session.js";
import { handleCronSlash } from "./replCron.js";
import { handleTelegramSlash, type PollerHandle, type TelegramTurnDeps } from "./replTelegram.js";

export interface SlashCtx {
  messages: CoreMessage[]; // mutated in place by /new + /compact
  sessionFile: { path: string }; // mutable wrapper so /new can rotate
  tokenBudget: TokenBudget;
  model: LanguageModel;
  out: NodeJS.WritableStream;
  cwd: string;
  abortSignal?: AbortSignal;
  /** P-10 / D-9: schedule.jsonl path used by /cron subcommands. */
  schedulePath: string;
  /** P-11 / D-8: telegram.json path used by /telegram subcommands. */
  telegramConfigPath: string;
  /** P-11 / D-8: poller-scoped abort controller; null when poller not running. */
  telegramAbort: AbortController | null;
  /** P-11 / D-8: live poller-handle ref; null when not running. */
  pollerHandle: PollerHandle | null;
  /** P-11 / D-8: setter so /telegram on can attach a freshly-started poller back into ctx. */
  onPollerStart: (handle: PollerHandle | null) => void;
  /** P-11 / D-19: shared mutex (operator + cron + telegram). */
  turnLock: TurnLock;
  /** P-11 / D-7: deps the /telegram on path needs to boot a poller in-place. */
  telegramDeps: TelegramTurnDeps;
}

export interface SlashResult {
  handled: boolean;
}

// rev-3: 3 commands. /cost removed; status line at terminal row 0 shows
// context fill + tokens + model + session id always-on.
const HELP_TEXT = `mai REPL slash commands:
  /compact   summarize this session, keep last 10 messages
  /new       start a fresh session in this REPL
  /cron      schedule recurring or one-shot prompts:
               /cron schedule "<task>" --cron "<5-field cron>"
               /cron schedule "<task>" --at "<HH:MM | ISO>"
               /cron list
               /cron remove <id>
  /telegram  bidirectional Telegram channel:
               /telegram on        enable + start poller (requires TELEGRAM_TOKEN + bound chat_id)
               /telegram off       disable + stop poller
               /telegram status    show config + poller state
  /help      show this list
status line at top of terminal shows current context %, tokens, model, session id.
multi-line input: end a line with \\ to continue on the next line.\n`;

export async function dispatchSlash(line: string, ctx: SlashCtx): Promise<SlashResult> {
  if (!line.startsWith("/")) return { handled: false };
  const cmd = line.split(/\s+/)[0];
  switch (cmd) {
    case "/help":
      ctx.out.write(HELP_TEXT);
      return { handled: true };
    // rev-3: /cost removed. Status line (D-18) replaces it.
    case "/new": {
      ctx.messages.length = 0;
      ctx.sessionFile.path = newSessionFile(ctx.cwd);
      ctx.tokenBudget.reset();
      ctx.out.write(`(new session: ${ctx.sessionFile.path.split("/").pop()})\n`);
      return { handled: true };
    }
    case "/cron": {
      await handleCronSlash(line, ctx.schedulePath, ctx.out);
      return { handled: true };
    }
    case "/telegram": {
      await handleTelegramSlash(line, {
        out: ctx.out,
        configPath: ctx.telegramConfigPath,
        pollerHandle: ctx.pollerHandle,
        onPollerStart: (handle) => {
          ctx.telegramAbort = handle?.abort ?? null;
          ctx.onPollerStart(handle);
        },
        turnLock: ctx.turnLock,
        deps: ctx.telegramDeps,
      });
      return { handled: true };
    }
    case "/compact": {
      // rev-2 D-17: no-op skip when nothing to compact (already short).
      const LAST_K = 10;
      if (ctx.messages.length <= LAST_K) {
        ctx.out.write(`(/compact: nothing to compact — already short, ${ctx.messages.length} messages)\n`);
        return { handled: true };
      }
      const before = ctx.messages.length;
      // rev-2 D-16: failure = no-op + notify; do NOT mutate session state.
      try {
        const { newMessages, marker } = await compactMessages({
          model: ctx.model,
          messages: ctx.messages,
          lastK: LAST_K,
          abortSignal: ctx.abortSignal,
        });
        ctx.messages.length = 0;
        ctx.messages.push(...newMessages);
        rewriteSession(ctx.sessionFile.path, ctx.messages);
        writeCompactionMarker(ctx.sessionFile.path, marker);
        ctx.tokenBudget.reset();
        ctx.out.write(`✓ compacted (${before} → ${ctx.messages.length})\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.out.write(`⚠ compaction failed: ${msg} — session unchanged\n`);
      }
      return { handled: true };
    }
    default:
      ctx.out.write(`unknown slash command: ${cmd}. type /help for the list.\n`);
      return { handled: true };
  }
}
