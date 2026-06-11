import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CoreMessage } from "ai";
import { getHomeBase } from "./paths.js";

/** Root directory for all sessions. ~/.mai/agent/sessions/<cwd-hash>/<ts>.jsonl */
export const SESSIONS_ROOT = (): string => join(getHomeBase(), ".mai", "agent", "sessions");

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
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    // P-7 (F-9): write cwd.txt companion for Frondose session cwd recovery.
    // Pre-P-7 hash dirs lack this file — `listAllSessions` falls back to hash.
    writeFileSync(join(dir, "cwd.txt"), cwd, "utf-8");
  }
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

/**
 * P-8 (D-10): atomically rewrite the session file with a new messages array.
 * Writes to `${file}.tmp` then renames over `file`. POSIX rename is atomic.
 */
export function rewriteSession(file: string, messages: CoreMessage[]): void {
  const tmp = `${file}.tmp`;
  const lines = messages.length === 0 ? "" : `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`;
  writeFileSync(tmp, lines, "utf-8");
  renameSync(tmp, file);
}

/**
 * P-8 (D-4): write a compaction sidecar at `${sessionFile}.compact.json`.
 * Sidecar exists purely as informational metadata; loadMessages does NOT read it.
 */
export function writeCompactionMarker(sessionFile: string, marker: unknown): void {
  writeFileSync(`${sessionFile}.compact.json`, JSON.stringify(marker, null, 2), "utf-8");
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

/** P-7 (F-9): a single session's metadata for Frondose session recovery. */
export interface SessionEntry {
  sessionId: string; // basename without .jsonl
  path: string; // absolute path
  cwdHash: string; // sub-directory name
  cwdLabel: string | null; // contents of cwd.txt if present
  mtimeMs: number;
  messageCount: number;
  firstPrompt: string | null;
}

/** P-7 (F-9): enumerate all session JSONL files across all cwdHash directories under SESSIONS_ROOT. */
export function listAllSessions(): SessionEntry[] {
  const root = SESSIONS_ROOT();
  if (!existsSync(root)) return [];
  const out: SessionEntry[] = [];
  for (const hashDir of readdirSync(root)) {
    const dirPath = join(root, hashDir);
    let dirStat: ReturnType<typeof statSync>;
    try {
      dirStat = statSync(dirPath);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    // cwd.txt label (post-P-7 sessions only).
    let cwdLabel: string | null = null;
    const cwdTxtPath = join(dirPath, "cwd.txt");
    if (existsSync(cwdTxtPath)) {
      try {
        cwdLabel = readFileSync(cwdTxtPath, "utf-8").trim();
      } catch {
        cwdLabel = null;
      }
    }
    // List .jsonl files in this hash dir.
    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(dirPath, file);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(filePath);
      } catch {
        continue;
      }
      const sessionId = file.slice(0, -".jsonl".length);
      // Read first JSONL line for prompt preview + message count.
      let messageCount = 0;
      let firstPrompt: string | null = null;
      try {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split(/\r?\n/).filter(Boolean);
        messageCount = lines.length;
        const firstLine = lines[0];
        if (firstLine) {
          try {
            const msg = JSON.parse(firstLine) as { role: string; content: unknown };
            if (msg.role === "user") {
              if (typeof msg.content === "string") firstPrompt = msg.content;
              else if (Array.isArray(msg.content)) {
                const firstText = (msg.content as Array<{ type: string; text?: string }>).find(
                  (c) => c.type === "text" && typeof c.text === "string",
                );
                firstPrompt = firstText?.text ?? null;
              }
            }
          } catch {
            // Malformed JSONL line — skip preview.
          }
        }
      } catch {
        // unreadable — keep stat, skip preview.
      }
      out.push({
        sessionId,
        path: filePath,
        cwdHash: hashDir,
        cwdLabel,
        mtimeMs: stat.mtimeMs,
        messageCount,
        firstPrompt,
      });
    }
  }
  return out;
}
