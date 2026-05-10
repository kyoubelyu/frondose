/**
 * P-10 / D-3 / D-8: /cron slash command + REPL drain/poll integration.
 *
 * Exposes:
 *   - parseCronSlashLine: argv-style parser for "/cron <verb> <args>"
 *   - handleCronSlash:    /cron schedule | list | remove dispatcher (writes schedule.jsonl)
 *   - runCronTurn:        helper that injects [CRON_RUN_ID=...]\n<task> as a user message
 *                         and runs the agent loop (called from boot drain + after-turn poll)
 *   - drainDueJobs:       boot-time + after-turn loop (called from repl.ts; abort-aware)
 */
import { randomUUID } from "node:crypto";
import type { CoreMessage, LanguageModel, StepResult, ToolSet } from "ai";
import { runAgentLoop } from "../agent/loop.js";
import {
  computeCronRunId,
  findDueJobs,
  markRan,
  nextRunAfter,
  parseAtSpec,
  parseCronExpr,
  readSchedule,
  type ScheduleRecord,
  writeSchedule,
} from "../persistence/schedule.js";
import { appendMessages } from "../persistence/session.js";

export type CronSlashParsed =
  | { verb: "schedule"; task: string; recurring: string | null; oneShot: string | null }
  | { verb: "list" }
  | { verb: "remove"; id: string };

/** Tokenize a slash line respecting double-quoted strings. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

export function parseCronSlashLine(line: string): CronSlashParsed {
  const tokens = tokenize(line);
  // tokens[0] === "/cron"; verb is tokens[1]
  const verb = tokens[1];
  if (!verb) throw new Error("/cron requires a verb (schedule | list | remove)");
  if (verb === "list") return { verb: "list" };
  if (verb === "remove") {
    const id = tokens[2];
    if (!id) throw new Error("/cron remove: id required");
    return { verb: "remove", id };
  }
  if (verb !== "schedule") {
    throw new Error(`unknown /cron verb "${verb}" (expected schedule | list | remove)`);
  }
  // schedule path
  const task = tokens[2];
  if (!task) throw new Error("/cron schedule: quoted task required");
  let recurring: string | null = null;
  let oneShot: string | null = null;
  for (let i = 3; i < tokens.length; i++) {
    if (tokens[i] === "--cron") {
      recurring = tokens[++i] ?? null;
    } else if (tokens[i] === "--at") {
      oneShot = tokens[++i] ?? null;
    }
  }
  if (recurring && oneShot) throw new Error("/cron schedule: --cron and --at are mutually exclusive");
  if (!recurring && !oneShot) throw new Error("/cron schedule: --cron or --at required");
  return { verb: "schedule", task, recurring, oneShot };
}

export interface RunCronTurnDeps {
  model: LanguageModel;
  system: string;
  messages: CoreMessage[];
  tools: ToolSet;
  sessionFile: string;
  abortSignal?: AbortSignal;
  onStepFinish?: (step: StepResult<ToolSet>) => Promise<void> | void;
  out: NodeJS.WritableStream;
}

/** D-14: prepend [CRON_RUN_ID=...]\n header; run agent loop; persist tail; same shape as operator turn. */
export async function runCronTurn(
  record: ScheduleRecord,
  fireDate: Date,
  schedulePath: string,
  deps: RunCronTurnDeps,
): Promise<void> {
  const cronRunId = computeCronRunId(record, fireDate);
  const prompt = `[CRON_RUN_ID=${cronRunId}]\n${record.task}`;
  deps.out.write(`\n[cron-fired] ${cronRunId} — running scheduled task\n`);
  const turnStart = deps.messages.length;
  deps.messages.push({ role: "user", content: prompt });
  await runAgentLoop({
    model: deps.model,
    system: deps.system,
    messages: deps.messages,
    tools: deps.tools,
    abortSignal: deps.abortSignal,
    onStepFinish: deps.onStepFinish,
  });
  // D-16: skip persistence + schedule update on abort. On next REPL boot,
  // drainDueJobs re-queues this record (markRan wasn't called, nextRunAt unchanged)
  // and re-fires with the SAME cron_run_id (BLOCKER-1 fix — fireDate=record.nextRunAt).
  if (deps.abortSignal?.aborted) return;
  appendMessages(deps.sessionFile, deps.messages.slice(turnStart));

  // Update / remove schedule record
  const records = readSchedule(schedulePath);
  const idx = records.findIndex((r) => r.id === record.id);
  if (idx >= 0) {
    const updated = markRan(records[idx]!, fireDate);
    if (updated === null) {
      records.splice(idx, 1);
    } else {
      records[idx] = updated;
    }
    writeSchedule(schedulePath, records);
  }
}

/** Boot-time + after-turn poll: fire all currently-due jobs in createdAt-asc order, abort-aware. */
export async function drainDueJobs(
  schedulePath: string,
  abortSignal: AbortSignal | undefined,
  deps: RunCronTurnDeps,
): Promise<void> {
  while (true) {
    if (abortSignal?.aborted) return;
    const records = readSchedule(schedulePath);
    const due = findDueJobs(records, new Date());
    if (due.length === 0) return;
    due.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const next = due[0]!;
    // BLOCKER-1 fix + D-6: fireDate is record.nextRunAt, NOT wall-clock Date.now().
    // On crash recovery, this preserves the original cron_run_id so the LLM's
    // checkpoint_key getMemory lookups still hit prior in-flight progress.
    await runCronTurn(next, new Date(next.nextRunAt), schedulePath, deps);
  }
}
// NIT-1 (Round 1): peekDueJob alias intentionally NOT exported — drainDueJobs has
// full side-effects, "peek" semantics would invert the contract.

/** /cron schedule | list | remove dispatcher. Writes to `out`. */
export async function handleCronSlash(line: string, schedulePath: string, out: NodeJS.WritableStream): Promise<void> {
  let parsed: CronSlashParsed;
  try {
    parsed = parseCronSlashLine(line);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out.write(`/cron: ${msg}\n`);
    return;
  }
  if (parsed.verb === "list") {
    const records = readSchedule(schedulePath);
    if (records.length === 0) {
      out.write("(no scheduled jobs)\n");
      return;
    }
    const sorted = [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const r of sorted) {
      const id8 = r.id.replace(/-/g, "").slice(0, 8);
      const taskTrim = r.task.length > 40 ? `${r.task.slice(0, 40)}…` : r.task;
      const last = r.lastRunAt ?? "(never)";
      out.write(`${id8}  ${taskTrim.padEnd(41)}  ${r.cronExpr.padEnd(20)}  ${r.enabled ? "yes" : "no "}  ${last}\n`);
    }
    return;
  }
  if (parsed.verb === "remove") {
    const records = readSchedule(schedulePath);
    const idx = records.findIndex((r) => r.id.replace(/-/g, "").startsWith(parsed.id));
    if (idx < 0) {
      out.write(`/cron remove: no schedule with id "${parsed.id}"\n`);
      return;
    }
    const removed = records.splice(idx, 1)[0]!;
    writeSchedule(schedulePath, records);
    out.write(`removed: ${removed.id.replace(/-/g, "").slice(0, 8)} — ${removed.task.slice(0, 40)}\n`);
    return;
  }
  // schedule
  try {
    const now = new Date();
    let cronExpr: string;
    let type: "recurring" | "oneshot";
    let firstNext: Date;
    if (parsed.recurring) {
      const p = parseCronExpr(parsed.recurring); // validates
      cronExpr = parsed.recurring;
      type = "recurring";
      firstNext = nextRunAfter(p, now);
    } else if (parsed.oneShot) {
      const at = parseAtSpec(parsed.oneShot, now);
      cronExpr = `at:${at.toISOString()}`;
      type = "oneshot";
      firstNext = at;
    } else {
      throw new Error("internal: schedule verb requires --cron or --at");
    }
    const record: ScheduleRecord = {
      id: randomUUID(),
      task: parsed.task,
      cronExpr,
      type,
      enabled: true,
      createdAt: now.toISOString(),
      lastRunAt: null,
      nextRunAt: firstNext.toISOString(),
    };
    const records = readSchedule(schedulePath);
    records.push(record);
    writeSchedule(schedulePath, records);
    const id8 = record.id.replace(/-/g, "").slice(0, 8);
    out.write(`scheduled: ${id8} — ${type} — next ${firstNext.toISOString()}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out.write(`/cron schedule: ${msg}\n`);
  }
}
