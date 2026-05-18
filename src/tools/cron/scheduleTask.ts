/** P-31: `schedule_task` — lets the agent schedule a RECURRING task for itself.
 *  Wraps the existing schedule.ts helpers; writes to schedule.jsonl. The cron
 *  fires via the worker REPL's P-19 tick / the server's P-31 tick. */
import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import {
  nextRunAfter,
  parseCronExpr,
  readSchedule,
  type ScheduleRecord,
  writeSchedule,
} from "../../persistence/schedule.js";

export function makeScheduleTaskTool(schedulePath: string) {
  return tool({
    description:
      "Schedule a RECURRING task for yourself. The task fires on the cron schedule as a " +
      "new turn. Use when the operator wants something to repeat (e.g. daily outreach). " +
      "cron_expr is a 5-field expression; each field is `*`, `*/N` (step), or a single " +
      "integer — ranges (`1-5`), lists (`1,3`) and names are NOT supported. " +
      "Examples: `0 9 * * *` (daily 09:00), `*/15 * * * *` (every 15 min).",
    parameters: z.object({
      task: z.string().min(1).describe("What to do when this fires — a prompt to yourself."),
      cron_expr: z.string().min(1).describe("5-field cron: `*`, `*/N`, or a single integer per field."),
    }),
    execute: async ({ task, cron_expr }) => {
      let parsed: ReturnType<typeof parseCronExpr>;
      try {
        parsed = parseCronExpr(cron_expr);
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
      const now = new Date();
      const record: ScheduleRecord = {
        id: randomUUID(),
        task,
        cronExpr: cron_expr,
        type: "recurring",
        enabled: true,
        createdAt: now.toISOString(),
        lastRunAt: null,
        nextRunAt: nextRunAfter(parsed, now).toISOString(),
      };
      const records = readSchedule(schedulePath);
      records.push(record);
      writeSchedule(schedulePath, records);
      return { ok: true as const, id: record.id, nextRunAt: record.nextRunAt };
    },
  });
}
