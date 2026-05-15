/** P-26: send_worker_message server-side tool — inserts into worker_pending.
 *  Step-3b C-1 null guard: when DBs aren't yet initialized (server boot before
 *  `mai server worker add`), execute returns a structured envelope instead of
 *  crashing on `listWorkers(null)`. */
import { tool } from "ai";
import type { Database as DB } from "better-sqlite3";
import { z } from "zod";
import { enqueueWorkerPending } from "../../persistence/serverInbox.js";
import { listWorkers } from "../../persistence/workersRegistry.js";

export function makeSendWorkerMessageTool(workersDb: DB | null, serverInboxDb: DB | null) {
  return tool({
    description:
      "Send a directive to a specific worker's inbox. Worker drains its inbox before each LLM turn " +
      "(maximum ~60s latency). Use to push 'STOP outreach for 24h', 'shift to ICP X', etc.",
    parameters: z.object({
      workerId: z.string().min(1),
      content: z.string().min(1).max(4000),
    }),
    execute: async (input): Promise<unknown> => {
      // Step-3b C-1: null-guard graceful envelope.
      if (!workersDb || !serverInboxDb) {
        return { ok: false, error: "Server registry unavailable" };
      }
      const workers = listWorkers(workersDb);
      const hit = workers.find((w) => w.worker_id === input.workerId && w.status === "active");
      if (!hit) return { ok: false, error: `unknown or revoked worker ${input.workerId}` };
      const id = enqueueWorkerPending(serverInboxDb, input.workerId, input.content);
      return { ok: true, queuedId: id };
    },
  });
}
