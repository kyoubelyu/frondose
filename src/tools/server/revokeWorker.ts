/** P-27: revoke_worker server tool. */
import { tool } from "ai";
import type { Database as DB } from "better-sqlite3";
import { z } from "zod";
import { removeWorker } from "../../persistence/workersRegistry.js";

export function makeRevokeWorkerTool(workersDb: DB | null) {
  return tool({
    description:
      "Revoke a worker's permanent token. Next REST call from that worker returns 401, " +
      "triggering safe-mode. Use when a worker VM is decommissioned or compromised.",
    parameters: z.object({
      workerId: z.string().min(1),
    }),
    execute: async (input) => {
      if (!workersDb) return { ok: false, error: "workers.sqlite not initialized" };
      const ok = removeWorker(workersDb, input.workerId);
      if (!ok) return { ok: false, error: `worker_id not found: ${input.workerId}` };
      return { ok: true, message: `${input.workerId} revoked; next heartbeat/poll will 401.` };
    },
  });
}
