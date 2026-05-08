import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CoreMessage } from "ai";

/** Root directory for all sessions. ~/.mai/agent/sessions/<cwd-hash>/<ts>.jsonl */
export const SESSIONS_ROOT = (): string => join(homedir(), ".mai", "agent", "sessions");

/**
 * Stable, short hash of a cwd path. 16 hex chars of SHA-256 = 64 bits of
 * collision space — effectively zero collisions for any reasonable number of
 * cwds on one machine.
 */
export function cwdHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

/** Directory for sessions associated with this cwd. Auto-created. */
export function sessionDir(cwd: string): string {
  const dir = join(SESSIONS_ROOT(), cwdHash(cwd));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Generate a fresh session file path with an ISO timestamp prefix (sortable). */
export function newSessionFile(cwd: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(sessionDir(cwd), `${ts}.jsonl`);
}

/**
 * Find the most-recent session JSONL file for this cwd. Selection: latest
 * mtime among `*.jsonl` in the session dir. Returns undefined if none exists.
 */
export function findRecentSessionFile(cwd: string): string | undefined {
  const dir = sessionDir(cwd);
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) return undefined;
  let best: { path: string; mtime: number } | undefined;
  for (const f of files) {
    const path = join(dir, f);
    const m = statSync(path).mtimeMs;
    if (!best || m > best.mtime) best = { path, mtime: m };
  }
  return best?.path;
}

/**
 * Either resume the latest session for this cwd or start a fresh one.
 * Returns the resolved file path (always defined; auto-creates the path).
 */
export function continueRecent(cwd: string, opts: { newSession?: boolean } = {}): string {
  if (opts.newSession === true) return newSessionFile(cwd);
  const recent = findRecentSessionFile(cwd);
  return recent ?? newSessionFile(cwd);
}

/**
 * Append CoreMessages as JSONL (one per line, trailing newline).
 * `appendFileSync` is atomic per-call on POSIX, so partial writes are not a
 * concern as long as the caller batches per turn.
 */
export function appendMessages(file: string, messages: CoreMessage[]): void {
  if (messages.length === 0) return;
  const lines = `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`;
  appendFileSync(file, lines, "utf-8");
}

/** Load all CoreMessages from a JSONL file; tolerate empty lines. */
export function loadMessages(file: string): CoreMessage[] {
  if (!existsSync(file)) return [];
  const content = readFileSync(file, "utf-8");
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CoreMessage);
}
