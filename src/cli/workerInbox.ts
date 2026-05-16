/** P-26 Step-3b B-1: orchestrator for the worker inbox drain.
 *  CLI layer (mirrors `drainDueJobs` in `src/cli/replCron.ts`).
 *  Imports persistence helpers + `runAgentLoop` + `appendMessages`.
 *  Persistence layer (workerInbox.ts) does NOT import agent layer.
 *
 *  Invariant: mark-consumed-BEFORE-inject prevents double-injection if
 *  `runAgentLoop` throws mid-iteration. The caller wraps this in
 *  `turnLock.run()` + try/catch (§6.18). */
import { runAgentLoop } from "../agent/loop.js";
import { appendMessages } from "../persistence/session.js";
import {
  deleteWorkerInboxMessages,
  openWorkerInboxDb,
  peekPendingWorkerInboxMessages,
} from "../persistence/workerInbox.js";
import type { RunCronTurnDeps } from "./replCron.js";

export async function drainWorkerInbox(
  dbPath: string,
  abortSignal: AbortSignal | undefined,
  deps: RunCronTurnDeps,
): Promise<void> {
  const db = openWorkerInboxDb(dbPath);
  const pending = peekPendingWorkerInboxMessages(db);
  if (pending.length === 0) return;
  // P-28.5 D-6: delete-BEFORE-inject (atomicity invariant). If runAgentLoop
  // throws mid-iteration, the already-injected rows are already removed (no
  // double-inject on retry). Rows are DELETED rather than marked consumed —
  // inbox content may carry plaintext credentials; the partial turn is still
  // visible in the session JSONL.
  deleteWorkerInboxMessages(
    db,
    pending.map((r) => r.id),
  );
  for (const row of pending) {
    if (abortSignal?.aborted) return;
    const turnStart = deps.messages.length;
    deps.messages.push({ role: "user", content: row.content });
    await runAgentLoop({
      model: deps.model,
      system: deps.system,
      messages: deps.messages,
      tools: deps.tools,
      abortSignal,
      onStepFinish: deps.onStepFinish,
    });
    appendMessages(deps.sessionFile, deps.messages.slice(turnStart));
  }
}
