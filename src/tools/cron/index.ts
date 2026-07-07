/**
 * P-31 Step 4a STUB — cron tool group registry.
 * Builder replaces this at Step 4b per plan §6.2.
 *
 * One tool: `schedule_task`. The makeCronTools factory mirrors the other
 * make*Tools factories for symmetry.
 */
import type { ToolSet } from "ai";
import { makeScheduleTaskTool } from "./scheduleTask.js";
import { makeStopAutoTool } from "./stopAuto.js";

/** P-31: cron tool group. */
export function makeCronTools(schedulePath: string): ToolSet {
  return {
    schedule_task: makeScheduleTaskTool(schedulePath),
    stop_auto: makeStopAutoTool(schedulePath),
  };
}
