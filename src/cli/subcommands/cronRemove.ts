/**
 * P-13 D-10 + B-1 (Step 3b): DI-injectable helper for `mai cron remove` interactive path.
 *
 * Extracted from main.ts Commander action body so T-CronI.2/3 can inject mockPrompter.
 * D-3 prohibits ESM module mocking; the only way for tests to intercept
 * schedulesSelect + confirm calls is via the optional 2nd-arg prompter param.
 *
 * Returns: the selected job id on confirm-true, OR null when:
 *   (a) schedule.jsonl is empty
 *   (b) schedulesSelect returned null
 *   (c) operator declined the destructive confirm (Cancelled.)
 * Caller (main.ts cron remove action) handles null by exiting cleanly.
 */
import { readSchedule } from "../../persistence/schedule.js";
import { type Prompter, realPrompter } from "./_prompts.js";

export async function runCronRemoveInteractive(
  schedulePath: string,
  prompter: Prompter = realPrompter,
): Promise<string | null> {
  const jobs = readSchedule(schedulePath);
  if (jobs.length === 0) {
    process.stdout.write("No scheduled jobs.\n");
    return null;
  }
  const selectedId = await prompter.schedulesSelect(jobs);
  if (selectedId === null) return null;
  const targetTask = jobs.find((j) => j.id === selectedId)?.task.slice(0, 40) ?? "(unknown)";
  const confirmed = await prompter.confirm(`Remove job "${targetTask}"?`, false);
  if (!confirmed) {
    process.stdout.write("Cancelled.\n");
    return null;
  }
  return selectedId;
}
