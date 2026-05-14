/** P-23: shared session JSONL used by daemon + REPL when cfg.enabled (plan §6.6).
 *
 * Append-only.
 *
 * Concurrency model (Step-3b C4):
 *   Two layered mechanisms prevent cross-process JSONL corruption:
 *     (a) repl.pid mutual exclusion (§6.7): when REPL is alive, the daemon's
 *         §6.4 gate prevents handleTelegramTurn from running. When daemon is
 *         alive, the REPL's in-process Telegram poller is disabled. This is a
 *         liveness check — it avoids contention in practice but is NOT a lock.
 *     (b) Cross-process turn-lock wrapping: appendMessagesShared callers MUST
 *         hold `acquireTurnLock(turn.lock)` for the duration of the append.
 *         This is the defense-in-depth guarantee against gate-check regression.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CoreMessage } from "ai";

export function sharedSessionPath(): string {
  const dir = path.join(os.homedir(), ".mai", "agent", "sessions", "shared");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, "active.jsonl");
}

/** Append messages as JSONL.
 *  CALLER CONTRACT: caller MUST hold acquireTurnLock(turn.lock) before calling.
 *  POSIX O_APPEND is atomic only for writes ≤ PIPE_BUF (~4 KB); long messages
 *  can split mid-line without the cross-process lock. */
export function appendMessagesShared(file: string, messages: CoreMessage[]): void {
  if (messages.length === 0) return;
  const lines = `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`;
  appendFileSync(file, lines, "utf-8");
}

export function loadMessagesShared(file: string): CoreMessage[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CoreMessage);
}
