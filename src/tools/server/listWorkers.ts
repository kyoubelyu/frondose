/** P-26: list_workers tool — REPLACES the P-25 always-empty stub with a real
 *  registry-backed lookup. Null guard so server boots cleanly before
 *  `mai server worker add` has created workers.sqlite. */
import { tool } from "ai";
import type { Database as DB } from "better-sqlite3";
import { z } from "zod";
import { listWorkers } from "../../persistence/workersRegistry.js";

export function makeListWorkersTool(workersDb: DB | null) {
  return tool({
    description: "List all registered workers with their status and last heartbeat.",
    parameters: z.object({}),
    execute: async () => {
      if (!workersDb) {
        return { workers: [], note: "workers.sqlite not yet initialized" };
      }
      const rows = listWorkers(workersDb);
      return { workers: rows };
    },
  });
}
