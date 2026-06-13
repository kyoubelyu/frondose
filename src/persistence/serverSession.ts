/** P-25: server session file helpers (OQ-4: no cwdHash; flat sessions dir).
 *  Mirrors src/persistence/session.ts but scoped to ~/.frondose/server/sessions/.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoreMessage } from "ai";
import { SERVER_SESSIONS_ROOT } from "./serverPaths.js";

/** Returns a new session-file path under ~/.frondose/server/sessions/; auto-creates the dir. */
export function serverSessionFile(): string {
  const dir = SERVER_SESSIONS_ROOT();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dir, `${ts}.jsonl`);
}

/** Load messages from an existing session file; returns [] if absent. */
export function loadServerSession(file: string): CoreMessage[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CoreMessage);
}

/** Append messages to a session file (POSIX O_APPEND — atomic for <PIPE_BUF writes). */
export function appendServerSession(file: string, messages: CoreMessage[]): void {
  if (messages.length === 0) return;
  appendFileSync(file, `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`, "utf-8");
}
