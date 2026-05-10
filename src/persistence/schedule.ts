/**
 * P-10 / D-2 / D-4 / D-5 / D-7: cron schedule persistence + cron expression parser.
 *
 * Single global file at MAI_SCHEDULE_PATH (default ~/.mai/agent/schedule.jsonl).
 * No per-cwd / per-session scoping (D-18). Concurrent multi-process writes
 * are out of scope (D-17 — operator runs 1 mai binary at a time).
 *
 * Cron parser supports: `*`, `*\/N` (step), single integer. 5 fields.
 * Unsupported (rejected with clear error): ranges, lists, named tokens, L/W/?.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface ScheduleRecord {
  id: string; // crypto.randomUUID()
  task: string; // prompt body (no [CRON_RUN_ID=] header — added at fire time)
  cronExpr: string; // "0 9 * * *" recurring; "at:<ISO>" one-shot
  type: "recurring" | "oneshot";
  enabled: boolean; // forward-compat for future /cron pause
  createdAt: string; // ISO 8601
  lastRunAt: string | null; // ISO 8601; null = never run
  nextRunAt: string; // ISO 8601; computed at create + after each run
}

interface CronField {
  kind: "any" | "exact" | "step";
  value?: number; // for kind="exact"
  step?: number; // for kind="step"
}

export interface ParsedCronExpr {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
  expr: string;
}

/** Parse a 5-field cron expression. Throws on unsupported / malformed input. */
export function parseCronExpr(expr: string): ParsedCronExpr {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields (got ${fields.length}): "${expr}"`);
  }
  const ranges = [
    [0, 59, "minute"],
    [0, 23, "hour"],
    [1, 31, "dayOfMonth"],
    [1, 12, "month"],
    [0, 6, "dayOfWeek"],
  ] as const;
  const parsed: CronField[] = fields.map((f, i) => {
    const [lo, hi, name] = ranges[i]!;
    if (f === "*") return { kind: "any" };
    if (f.startsWith("*/")) {
      const step = Number(f.slice(2));
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(`cron field ${name}: step "${f}" must be ">= 1"`);
      }
      return { kind: "step", step };
    }
    if (/^-?\d+$/.test(f)) {
      const n = Number(f);
      if (n < lo || n > hi) {
        throw new Error(`cron field ${name}: value ${n} out of range ${lo}-${hi}`);
      }
      return { kind: "exact", value: n };
    }
    throw new Error(`cron field ${name}: unsupported token "${f}" (supported: *, */N, integer)`);
  });
  return {
    minute: parsed[0]!,
    hour: parsed[1]!,
    dayOfMonth: parsed[2]!,
    month: parsed[3]!,
    dayOfWeek: parsed[4]!,
    expr,
  };
}

/** Compute the next firing moment STRICTLY AFTER `from`. Iterates minute-by-minute up to 1y. */
export function nextRunAfter(parsed: ParsedCronExpr, from: Date): Date {
  // Start at from + 1 minute (truncated to minute boundary).
  let candidate = new Date(from.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate = new Date(candidate.getTime() + 60_000);
  const limit = new Date(from.getTime() + 366 * 24 * 60 * 60_000);
  while (candidate < limit) {
    if (matches(parsed, candidate)) return candidate;
    candidate = new Date(candidate.getTime() + 60_000);
  }
  throw new Error(`cron expression "${parsed.expr}" produced no run within 1 year`);
}

function matches(p: ParsedCronExpr, d: Date): boolean {
  const m = d.getUTCMinutes();
  const h = d.getUTCHours();
  const dom = d.getUTCDate();
  const mon = d.getUTCMonth() + 1;
  const dow = d.getUTCDay();
  return (
    fieldMatches(p.minute, m) &&
    fieldMatches(p.hour, h) &&
    fieldMatches(p.dayOfMonth, dom) &&
    fieldMatches(p.month, mon) &&
    fieldMatches(p.dayOfWeek, dow)
  );
}

function fieldMatches(f: CronField, n: number): boolean {
  if (f.kind === "any") return true;
  if (f.kind === "exact") return n === f.value;
  if (f.kind === "step") return n % (f.step ?? 1) === 0;
  return false;
}

/** Read schedule.jsonl. Missing file → []. Malformed lines → warn-and-skip. */
export function readSchedule(path: string): ScheduleRecord[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8");
  const lines = content.split(/\r?\n/);
  const out: ScheduleRecord[] = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      out.push(JSON.parse(trimmed) as ScheduleRecord);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[mai] schedule.jsonl line ${i + 1} malformed (skipped): ${msg}\n`);
    }
  });
  return out;
}

/** Atomically rewrite schedule.jsonl. tmp+rename per existing rewriteSession pattern. */
export function writeSchedule(path: string, records: ScheduleRecord[]): void {
  const tmp = `${path}.tmp`;
  const body = records.length === 0 ? "" : `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, path);
}

/** Filter to records whose `nextRunAt <= now` AND `enabled === true`. Recurring + one-shot. */
export function findDueJobs(records: ScheduleRecord[], now: Date): ScheduleRecord[] {
  return records.filter((r) => {
    if (!r.enabled) return false;
    if (r.type === "oneshot" && r.lastRunAt) return false; // already fired
    return new Date(r.nextRunAt).getTime() <= now.getTime();
  });
}

/**
 * Update record after a successful fire.
 * Recurring: returns updated record with new lastRunAt + nextRunAt.
 * One-shot:  returns null (caller filters; record is removed from schedule).
 */
export function markRan(record: ScheduleRecord, fireDate: Date): ScheduleRecord | null {
  if (record.type === "oneshot") return null;
  const parsed = parseCronExpr(record.cronExpr);
  return {
    ...record,
    lastRunAt: fireDate.toISOString(),
    nextRunAt: nextRunAfter(parsed, fireDate).toISOString(),
  };
}

/** D-6: cron_run_id format = YYYYMMDD_HHmmss_<jobId8>. UTC-derived. */
export function computeCronRunId(record: ScheduleRecord, fireDate: Date): string {
  const yyyy = fireDate.getUTCFullYear().toString().padStart(4, "0");
  const mm = (fireDate.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = fireDate.getUTCDate().toString().padStart(2, "0");
  const hh = fireDate.getUTCHours().toString().padStart(2, "0");
  const mi = fireDate.getUTCMinutes().toString().padStart(2, "0");
  const ss = fireDate.getUTCSeconds().toString().padStart(2, "0");
  const jobId8 = record.id.replace(/-/g, "").slice(0, 8);
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}_${jobId8}`;
}

/** D-11: parse `--at` value. Two forms: HH:MM (local today/tomorrow) or ISO 8601 (absolute). */
export function parseAtSpec(input: string, now: Date): Date {
  const trimmed = input.trim();
  // ISO detection: contains T and starts with a 4-digit year.
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`--at: invalid ISO datetime "${input}" (expected YYYY-MM-DDTHH:MM:SSZ or HH:MM)`);
    }
    return d;
  }
  // HH:MM form
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!hhmm) {
    throw new Error(`--at: "${input}" not recognized (expected HH:MM or ISO datetime)`);
  }
  const hh = Number(hhmm[1]);
  const mi = Number(hhmm[2]);
  if (hh < 0 || hh > 23 || mi < 0 || mi > 59) {
    throw new Error(`--at: HH:MM out of range "${input}"`);
  }
  // Local-tz today at HH:MM. If past, roll to tomorrow.
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mi, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}
