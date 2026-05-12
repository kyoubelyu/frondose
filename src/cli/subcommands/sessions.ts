import { utimesSync } from "node:fs";
import { basename } from "node:path";
import { listAllSessions, newSessionFile, type SessionEntry } from "../../persistence/session.js";
import { isInteractive, type Prompter, printNoninteractiveGuidance, realPrompter } from "./_prompts.js";

export interface SessionsSubcommandOpts {
  sessionId?: string;
  json?: boolean;
}

export async function runSessionsSubcommand(
  action: "list" | "continue" | "new",
  opts: SessionsSubcommandOpts,
  // P-13 D-3: optional Prompter for interactive `continue` path.
  prompter: Prompter = realPrompter,
): Promise<void> {
  switch (action) {
    case "list": {
      const sessions = listAllSessions();
      if (opts.json) {
        for (const s of sessions) process.stdout.write(`${JSON.stringify(s)}\n`);
        return;
      }
      // Group by cwd label for table output.
      const byCwd = new Map<string, SessionEntry[]>();
      for (const s of sessions) {
        const label = s.cwdLabel ?? `(hash: ${s.cwdHash})`;
        const list = byCwd.get(label) ?? [];
        list.push(s);
        byCwd.set(label, list);
      }
      const total = sessions.length;
      process.stdout.write(`Sessions at ~/.mai/agent/sessions  (${total} total)\n\n`);
      const cwdEntries = [...byCwd.entries()].sort(([a], [b]) => a.localeCompare(b));
      for (const [label, list] of cwdEntries) {
        process.stdout.write(`cwd: ${label}\n`);
        // Sort by mtime desc — most recent first.
        list.sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const s of list) {
          const preview = (s.firstPrompt ?? "").slice(0, 60);
          process.stdout.write(
            `  ${s.sessionId}  [${s.messageCount} msgs]  "${preview}${preview.length === 60 ? "..." : ""}"\n`,
          );
        }
        process.stdout.write("\n");
      }
      return;
    }
    case "continue": {
      // P-13 D-3 + D-5: interactive top-10-by-mtime picker when no positional id + TTY.
      let sessionId = opts.sessionId;
      if (!sessionId && isInteractive()) {
        const top10 = listAllSessions()
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(0, 10);
        if (top10.length === 0) {
          process.stdout.write("No sessions found.\n");
          return;
        }
        sessionId = await prompter.sessionsSelect(top10);
      }
      if (!sessionId) {
        printNoninteractiveGuidance("sessions continue", "<session-id>", "<session-id-from-mai-sessions-list>");
        process.exit(1);
      }
      const all = listAllSessions();
      const match = all.find((s) => s.sessionId === sessionId);
      if (!match) {
        process.stderr.write(`[mai sessions continue] session-id '${sessionId}' not found.\n`);
        process.exit(1);
      }
      const now = new Date();
      utimesSync(match.path, now, now);
      process.stdout.write(`Resumed session ${match.sessionId} (${match.messageCount} messages).\n`);
      process.stdout.write("Run `mai` to continue this session.\n");
      return;
    }
    case "new": {
      const file = newSessionFile(process.cwd());
      const sessionId = basename(file, ".jsonl");
      process.stdout.write(`New session: ${sessionId}\n`);
      process.stdout.write("Run `mai` to start this session.\n");
      return;
    }
  }
}
