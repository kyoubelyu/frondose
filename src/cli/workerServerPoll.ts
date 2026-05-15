/** P-26: background server-poll loop for workers.
 *  Long-polls GET /api/worker_inbox/poll every `intervalMs` (default 30s)
 *  with server-side timeout=25s. Writes returned messages to worker_inbox
 *  SQLite. Inserts in a transaction so a crash mid-batch doesn't half-write.
 *  Silent on network failure — next tick retries. */
import { enqueueWorkerInbox, openWorkerInboxDb } from "../persistence/workerInbox.js";
import type { ServerCoords } from "../tools/server/queryLeadGlobally.js";

export function startWorkerServerPoll(
  serverCoords: ServerCoords,
  inboxDbPath: string,
  abortSignal: AbortSignal,
  intervalMs: number = 30_000,
): void {
  const pollOnce = async (): Promise<void> => {
    if (abortSignal.aborted) return;
    try {
      const res = await fetch(
        `${serverCoords.serverUrl}/api/worker_inbox/poll?worker_id=${encodeURIComponent(serverCoords.workerId)}&timeout=25`,
        {
          headers: { Authorization: `Bearer ${serverCoords.token}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (res.ok) {
        const { messages } = (await res.json()) as {
          messages: Array<{ id: number; content: string; ts: number }>;
        };
        if (messages.length > 0) {
          const db = openWorkerInboxDb(inboxDbPath);
          db.transaction(() => {
            for (const m of messages) enqueueWorkerInbox(db, m.content, m.ts);
          })();
        }
      }
    } catch {
      // Network failure — silent; next tick retries.
    }
    if (!abortSignal.aborted) setTimeout(pollOnce, intervalMs);
  };
  setTimeout(pollOnce, 0);
}
