/** P-25 stub: list_workers tool — always returns empty array at P-25.
 *  P-26 will replace the executor body with real worker registry lookup.
 */
import { tool } from "ai";
import { z } from "zod";

export const listWorkersTool = tool({
  description: "List all registered workers. Returns empty array until P-26.",
  parameters: z.object({}),
  execute: async () => ({
    workers: [],
    note: "Worker registration not yet implemented (P-26).",
  }),
});

export function makeListWorkersTool(): { list_workers: typeof listWorkersTool } {
  return { list_workers: listWorkersTool };
}
