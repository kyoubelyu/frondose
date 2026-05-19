import os from "node:os";
import path, { basename } from "node:path";
import readline from "node:readline";
import type { CoreMessage, LanguageModel, StepResult, ToolSet } from "ai";
import { compactMessages } from "../agent/compaction.js";
import { runAgentLoop } from "../agent/loop.js";
import { DEFAULT_MAX_STEPS } from "../agent/maxSteps.js";
import { TokenBudget } from "../agent/tokenBudget.js";
import { TurnLock } from "../agent/turnSemaphore.js";
import {
  acquireTurnLock,
  isPidAlive,
  readPid,
  releaseTurnLock,
  removePid,
  writePid,
} from "../persistence/processLock.js";
import { appendMessages, rewriteSession, writeCompactionMarker } from "../persistence/session.js";
import { appendMessagesShared } from "../persistence/sharedSession.js";
import { readTelegramConfig } from "../persistence/telegramConfig.js";
import { WORKER_INBOX_DB_PATH } from "../persistence/workerInbox.js";
import { renderMarkdown } from "./markdown.js";
import { drainDueJobs } from "./replCron.js";
import { dispatchSlash } from "./replSlash.js";
import { type PollerHandle, startTelegramPoller, type TelegramTurnDeps } from "./replTelegram.js";
import { StatusLine } from "./statusLine.js";
import { drainWorkerInbox } from "./workerInbox.js";

export interface ReplOpts {
  model: LanguageModel;
  system: string;
  /** Mutable; loop appends per turn. Loaded from session file at boot. */
  messages: CoreMessage[];
  tools: ToolSet;
  /** Path to the session JSONL file; new messages are appended after each turn. */
  sessionFile: string;
  /** P-8 (rev-2 NIT-3): cwd needed for /new to rotate session file. Optional —
   *  falls back to process.cwd() inside runRepl so existing test stubs still
   *  compile without a cwd field. */
  cwd?: string;
  /** Test injection. Defaults to process.stdout. */
  out?: NodeJS.WritableStream;
  /** Test injection. Defaults to process.stdin. */
  in_?: NodeJS.ReadableStream;
  /** P-6: REPL between-turn abort check; main.ts owns the controller. */
  abortController?: AbortController;
  /** P-6: passed through to runAgentLoop. */
  abortSignal?: AbortSignal;
  /** P-6: Vercel onStepFinish hook (e.g. audit writer). */
  onStepFinish?: (step: StepResult<ToolSet>) => Promise<void> | void;
  /** P-10 (D-9): schedule.jsonl path; default ~/.mai/agent/schedule.jsonl. */
  schedulePath?: string;
  /** P-11 (D-19): shared mutex for operator + cron + telegram turns. Default: fresh instance. */
  turnLock?: TurnLock;
  /** P-11 (D-7): telegram.json path. Default: ~/.mai/agent/telegram.json. */
  telegramConfigPath?: string;
  /** P-46 D-1b: resolved agent-loop step budget. Default DEFAULT_MAX_STEPS. */
  maxSteps?: number;
}

const AUTO_COMPACT_THRESHOLD = 0.5;

export async function runRepl(opts: ReplOpts): Promise<void> {
  const out = opts.out ?? process.stdout;
  const inputStream = opts.in_ ?? process.stdin;
  // Auto-detect TTY (per guardian critic CONCERN-3): true for real operator
  // session (line-editing UX); false for test-injected non-TTY streams.
  const isTty = inputStream === process.stdin && process.stdin.isTTY === true;
  const rl = readline.createInterface({ input: inputStream, output: out, terminal: isTty });

  // rev-2 NIT-3: cwd fallback so existing ReplOpts test stubs (which omit cwd)
  // continue to compile and run.
  const cwd = opts.cwd ?? process.cwd();
  const tokenBudget = new TokenBudget(opts.model);

  // P-23 §6.7: repl.pid lifecycle + cross-process turn-lock path. Written here
  // so daemon's §6.4 gate observes REPL liveness on subsequent poll iterations.
  const replPidPath = path.join(os.homedir(), ".mai", "agent", "repl.pid");
  const turnLockPath = path.join(os.homedir(), ".mai", "agent", "turn.lock");
  writePid(replPidPath);
  const cleanupReplPid = (): void => removePid(replPidPath);
  process.once("exit", cleanupReplPid);

  // P-23 §6.7: when daemon is alive, REPL switches its session file to the
  // shared JSONL so operator turns + daemon-deferred turns coexist on one log.
  const telegramPidPath = path.join(os.homedir(), ".mai", "agent", "telegram.pid");
  const daemonAliveAtBoot = isPidAlive(telegramPidPath);
  const sessionFileRef = { path: opts.sessionFile };
  const composedStepFinish = async (step: StepResult<ToolSet>) => {
    tokenBudget.add(step.usage);
    await opts.onStepFinish?.(step);
  };

  // P-12 D-6 + B-3 fix: declare pollerHandle + pollerAbort BEFORE refreshStatus is defined.
  // The closure body captures `let pollerHandle` by reference; placing the declarations earlier
  // prevents TDZ (`let` bindings throw ReferenceError when accessed before their declaration line
  // executes — NOT `undefined`). First refreshStatus() invocation at line 77 reads
  // `pollerHandle === null` cleanly → `null?.running === true` evaluates to false. Subsequent
  // re-bindings (poller start, /telegram on/off via onPollerStart) are observed by later invocations.
  let pollerHandle: PollerHandle | null = null;
  let pollerAbort: AbortController | null = null;

  // rev-3 D-18: status line. Construct once; no-op if not TTY.
  const statusLine = new StatusLine(out);
  const sessionId = (path: string) =>
    basename(path)
      .replace(/\.jsonl$/, "")
      .slice(0, 8);
  const refreshStatus = () =>
    statusLine.update(tokenBudget, opts.model, sessionId(sessionFileRef.path), pollerHandle?.running === true);
  // SIGWINCH: terminal resize → recompute width + redraw.
  const onResize = () => statusLine.handleResize();
  process.stdout.on?.("resize", onResize);
  refreshStatus();

  // multi-line accumulator
  let pending: string[] | null = null;

  // P-10 (D-9): schedule path for /cron persistence + drain/poll.
  const effectiveSchedulePath = opts.schedulePath ?? path.join(os.homedir(), ".mai", "agent", "schedule.jsonl");
  // P-11 (D-7): telegram config path.
  const effectiveTelegramConfigPath =
    opts.telegramConfigPath ?? path.join(os.homedir(), ".mai", "agent", "telegram.json");
  // P-11 (D-19): shared TurnLock — default-construct when absent (preserves test-stub compat).
  const turnLock = opts.turnLock ?? new TurnLock();
  // P-46 D-1b: effective step budget for this REPL session. Mutable — the
  // `/maxsteps` slash command retunes it for subsequent turns.
  let effectiveMaxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  // cronDeps mutates `sessionFile` after /new rotates the session file mid-loop.
  const cronDeps = {
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    maxSteps: effectiveMaxSteps,
    sessionFile: sessionFileRef.path,
    abortSignal: opts.abortSignal,
    onStepFinish: composedStepFinish,
    out,
  };
  // P-11 (D-7): telegram deps — same shape as cronDeps + telegram-specific fields.
  // P-12 D-1: pass sessionFileRef (the mutable object) instead of sessionFileRef.path —
  // background telegram turns observe rotation by `/new` because deps.sessionFile.path mutates.
  const telegramDeps: TelegramTurnDeps = {
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    maxSteps: effectiveMaxSteps,
    sessionFile: sessionFileRef,
    abortSignal: opts.abortSignal,
    onStepFinish: composedStepFinish,
    out,
    configPath: effectiveTelegramConfigPath,
    uploadAllowlistRoot: process.env.MAI_UPLOAD_ALLOWLIST ?? path.join(os.homedir(), ".mai", "agent", "uploads"),
  };
  // P-46 D-1b: `/maxsteps` retunes the operator turn budget AND the background
  // cron / telegram turn budgets (cronDeps + telegramDeps are mutated in place,
  // mirroring the existing cronDeps.sessionFile mutation pattern).
  const setMaxSteps = (n: number): void => {
    effectiveMaxSteps = n;
    cronDeps.maxSteps = n;
    telegramDeps.maxSteps = n;
  };

  // P-10 (D-3 + D-16): boot-time drain of overdue jobs before first prompt.
  // P-11 (D-19): wrap each cron drain in turnLock so operator + cron + telegram turns serialize.
  await turnLock.run(() => drainDueJobs(effectiveSchedulePath, opts.abortController?.signal, cronDeps));
  if (opts.abortController?.signal.aborted) {
    process.stdout.off?.("resize", onResize);
    statusLine.dispose();
    return;
  }

  // P-26 §6.18 / C-2: worker inbox drain — wraps in turnLock.run() (serializes
  // against Telegram poller + cron drain on the shared messages array) AND
  // try/catch (so a runAgentLoop throw inside drain doesn't kill the for-await
  // loop). Mark-consumed-BEFORE-inject invariant is preserved inside
  // drainWorkerInbox itself.
  const workerInboxDbPath = WORKER_INBOX_DB_PATH();
  const drainOnce = async (): Promise<void> => {
    await turnLock.run(async () => {
      try {
        await drainWorkerInbox(workerInboxDbPath, opts.abortController?.signal, cronDeps);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        out.write(`[mai] drainWorkerInbox failed: ${msg}; continuing\n`);
      }
    });
  };
  // Boot-time drain (BEFORE first prompt + AFTER cron drain).
  await drainOnce();
  if (opts.abortController?.signal.aborted) {
    process.stdout.off?.("resize", onResize);
    statusLine.dispose();
    return;
  }

  // P-19 D-1: background cron poll — fires every 60s.
  // Placed after abort gate: interval must NOT be created if boot drain already aborted.
  const cronInterval = setInterval(() => {
    turnLock.run(() => drainDueJobs(effectiveSchedulePath, opts.abortController?.signal, cronDeps));
  }, 60_000);
  cronInterval.unref();

  // P-11 (D-7): start Telegram poller if config has it enabled AND env+bind ready.
  // P-12 D-6 / B-3: pollerHandle + pollerAbort declarations moved before refreshStatus (line ~73) to avoid TDZ.
  // P-23 §6.7: when daemon is alive, REPL must NOT start its own poller (daemon owns inbound).
  const tgCfg = readTelegramConfig(effectiveTelegramConfigPath);
  if (tgCfg.enabled && daemonAliveAtBoot) {
    const daemonPid = readPid(telegramPidPath);
    out.write(`[telegram] daemon active (PID ${daemonPid}); REPL poller disabled — daemon owns inbound.\n`);
  } else if (tgCfg.enabled) {
    if (!process.env.TELEGRAM_TOKEN) {
      out.write("[telegram] config enabled but TELEGRAM_TOKEN unset — poller not started\n");
    } else if (tgCfg.boundUserId === null) {
      out.write("[telegram] config enabled but boundUserId null — run `mai telegram bind <user_id>` first\n");
    } else {
      pollerAbort = new AbortController();
      pollerHandle = await startTelegramPoller(tgCfg, telegramDeps, turnLock, pollerAbort);
    }
  }

  out.write("mai-agent ready. type a prompt; Ctrl-C exits.\n> ");
  for await (const rawLine of rl) {
    // P-6: between-turn stop check — if a prior turn's stop tool aborted, exit the loop.
    if (opts.abortController?.signal.aborted) break;

    // multi-line: trailing backslash continues
    const trimRight = rawLine.replace(/\s+$/, "");
    if (trimRight.endsWith("\\")) {
      const stripped = trimRight.slice(0, -1);
      if (pending == null) pending = [];
      pending.push(stripped);
      out.write("... ");
      continue;
    }
    let text: string;
    if (pending != null) {
      pending.push(rawLine);
      text = pending.join("\n").trim();
      pending = null;
    } else {
      text = rawLine.trim();
    }
    if (!text) {
      out.write("> ");
      continue;
    }

    // slash dispatch (REPL mode only — runOneShot bypasses this entirely per D-11)
    const slash = await dispatchSlash(text, {
      messages: opts.messages,
      sessionFile: sessionFileRef,
      tokenBudget,
      model: opts.model,
      out,
      cwd,
      abortSignal: opts.abortSignal,
      schedulePath: effectiveSchedulePath,
      telegramConfigPath: effectiveTelegramConfigPath,
      telegramAbort: pollerAbort,
      pollerHandle,
      onPollerStart: (handle) => {
        pollerHandle = handle;
        pollerAbort = handle?.abort ?? null;
      },
      turnLock,
      telegramDeps,
      maxSteps: effectiveMaxSteps,
      setMaxSteps,
    });
    if (slash.handled) {
      // rev-3 D-18: /compact and /new reset the budget; redraw status.
      refreshStatus();
      out.write("> ");
      continue;
    }

    // P-11 (D-19): serialize operator turn body behind cron / telegram turns.
    // P-23 §6.7 (C2 reciprocal): wrap operator turn + session append in the
    // cross-process turn.lock so daemon's §6.4 LockBusy gate observes us.
    const turnStart = opts.messages.length;
    opts.messages.push({ role: "user", content: text });
    let finalText = "";
    let tail: CoreMessage[] = [];
    const xLock = await acquireTurnLock(turnLockPath, "repl-op", { timeoutMs: 60_000 });
    try {
      await turnLock.run(async () => {
        await runAgentLoop({
          model: opts.model,
          system: opts.system,
          messages: opts.messages,
          tools: opts.tools,
          maxSteps: effectiveMaxSteps, // P-46 D-1b
          // D-7: NO onText — buffered render after the loop resolves
          abortSignal: opts.abortSignal,
          onStepFinish: composedStepFinish,
        });
      });
      tail = opts.messages.slice(turnStart);
      finalText = extractAssistantText(tail);
      // P-23 §6.7: when telegram cfg is enabled, append to shared JSONL; else per-cwd.
      if (tgCfg.enabled) appendMessagesShared(sessionFileRef.path, tail);
      else appendMessages(sessionFileRef.path, tail);
    } finally {
      releaseTurnLock(xLock);
    }

    // buffered markdown render of the final assistant text (D-7)
    if (finalText) out.write(`${renderMarkdown(finalText)}\n`);

    if (opts.abortController?.signal.aborted) break;

    // auto-compaction (D-8 + rev-2 D-16 / D-17)
    if (tokenBudget.lastPromptTokens >= tokenBudget.contextWindow * AUTO_COMPACT_THRESHOLD) {
      const LAST_K = 10;
      const pct = ((tokenBudget.lastPromptTokens / tokenBudget.contextWindow) * 100).toFixed(1);
      // D-17: no-op skip. If <= lastK messages exist, compaction can't shrink anything.
      if (opts.messages.length <= LAST_K) {
        out.write(`(auto-compact: context at ${pct}% but ${opts.messages.length} messages — nothing to compact)\n`);
      } else {
        out.write(`⏳ context at ${pct}% — compacting…\n`);
        // D-16: failure = no-op + notify. Do NOT mutate messages / file / budget on error.
        try {
          const { newMessages, marker } = await compactMessages({
            model: opts.model,
            messages: opts.messages,
            lastK: LAST_K,
            abortSignal: opts.abortSignal,
          });
          opts.messages.length = 0;
          opts.messages.push(...newMessages);
          rewriteSession(sessionFileRef.path, opts.messages);
          writeCompactionMarker(sessionFileRef.path, marker);
          tokenBudget.reset();
          out.write(`✓ compacted (${marker.summarizedCount} → ${marker.keptCount})\n`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          out.write(`⚠ auto-compaction failed: ${msg} — session unchanged, will retry next turn\n`);
        }
      }
    }

    // P-10 (D-3): after-turn poll for newly-due cron jobs.
    // Runs AFTER appendMessages + auto-compaction, BEFORE refreshStatus.
    // Refresh sessionFile in cronDeps in case /new rotated mid-turn.
    // P-11 (D-19): wrap drain in turnLock to serialize behind any in-flight telegram turn.
    // P-12 D-1: telegramDeps.sessionFile is the sessionFileRef object — mutates in place, no refresh needed.
    cronDeps.sessionFile = sessionFileRef.path;
    await turnLock.run(() => drainDueJobs(effectiveSchedulePath, opts.abortController?.signal, cronDeps));
    if (opts.abortController?.signal.aborted) break;

    // P-26 §6.18: drain worker inbox after each operator turn (mirrors drainDueJobs).
    await drainOnce();
    if (opts.abortController?.signal.aborted) break;

    // rev-3 D-18: redraw status after every turn (budget changed).
    refreshStatus();
    out.write("> ");
  }
  // rev-3: clean up status line on REPL exit (clear row 0).
  process.stdout.off?.("resize", onResize);
  statusLine.dispose();
  // P-11 (D-19): clean up Telegram poller on REPL exit.
  pollerAbort?.abort();
  // P-19 D-1: clean up background cron ticker on REPL exit.
  clearInterval(cronInterval);
  // P-23 §6.7: best-effort cleanup of repl.pid here (process.once('exit')
  // handler is the canonical safety net; this fires earlier on graceful loop fall-through).
  cleanupReplPid();
}

function extractAssistantText(turnMessages: CoreMessage[]): string {
  // last assistant message's text content (string OR array-with-text-parts)
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

/** One-shot mode: send one prompt, drain, persist, return. NO slash dispatch. */
export async function runOneShot(opts: ReplOpts & { prompt: string }): Promise<void> {
  const out = opts.out ?? process.stdout;
  const turnStart = opts.messages.length;
  opts.messages.push({ role: "user", content: opts.prompt });
  await runAgentLoop({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    maxSteps: opts.maxSteps, // P-46 D-1b
    onText: (delta) => out.write(delta), // unchanged: --prompt mode keeps streaming
    abortSignal: opts.abortSignal,
    onStepFinish: opts.onStepFinish,
  });
  out.write("\n");
  appendMessages(opts.sessionFile, opts.messages.slice(turnStart));
}
