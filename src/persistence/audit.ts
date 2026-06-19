import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { StepResult, ToolSet } from "ai";
import type { WorkflowAuditEntry } from "../agent/workflow/types.js";

export interface AuditEntry {
  ts: string; // ISO-8601 timestamp
  toolCallId: string; // from Vercel ToolResult
  toolName: string; // e.g. "remember", "telegram_notify"
  input: unknown; // tool args (Zod-validated; safe to log)
  output: unknown; // tool result (truncated to TRUNCATE_BYTES if string-coerced exceeds)
  error: string | null; // null on success
  stepFinishReason: string; // from StepResult.finishReason
}

const TRUNCATE_BYTES = 2000;
const PER_STRING_CAP = 2000;
const MAX_ELEMS = 50;
const MAX_KEYS = 50;
const MAX_DEPTH = 10;
const TRUNCATED_MARKER = "...[truncated]";
const CIRCULAR_MARKER = "[circular]";
const GETTER_MARKER = "[getter]";
const UNREADABLE_MARKER = "[unreadable]";

/**
 * Build a Vercel-compatible onStepFinish callback that appends one JSONL line
 * per tool call to auditPath. Synchronous file write (appendFileSync) ensures
 * each line is on disk before the callback resolves — critical because
 * process.exit(0) does not await pending async work.
 *
 * Failure of the audit write (disk full, permission error) logs a stderr
 * warning and returns cleanly. The agent loop must not crash on audit failure.
 *
 * Per scout F-5: zero modifications to existing tool implementations; all
 * tools get audited by this single subscriber.
 */
export function makeAuditWriter(auditPath: string): (step: StepResult<ToolSet>) => Promise<void> {
  // Eagerly ensure directory exists (one-time cost at writer creation).
  try {
    const dir = dirname(auditPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch (e) {
    process.stderr.write(
      `[frondose] audit writer: failed to ensure directory for ${auditPath}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }

  return async (step: StepResult<ToolSet>): Promise<void> => {
    try {
      const ts = new Date().toISOString();
      // Iterate toolResults — Vercel merges args + result into each entry by toolCallId.
      // Reference: scout F-5 + node_modules/ai/dist/index.d.ts:2111-2160.
      // Cast to a loose shape: the generic StepResult<ToolSet> collapses element type
      // to `never` because ToolResultUnion<TOOLS> needs concrete tool types to distribute.
      // The audit writer is intentionally tool-agnostic, so a runtime-shape cast is correct.
      const lines: string[] = [];
      const toolResults = step.toolResults as unknown as Array<{
        toolCallId: string;
        toolName: string;
        args: unknown;
        result: unknown;
      }>;
      for (const tr of toolResults) {
        const entry: AuditEntry = {
          ts,
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          input: truncateForAudit(tr.args),
          output: truncateForAudit(tr.result),
          error: null,
          stepFinishReason: step.finishReason,
        };
        lines.push(JSON.stringify(entry));
      }
      if (lines.length === 0) return;
      // Synchronous write per §2 nuance 14 — guarantees durability before exit.
      appendFileSync(auditPath, `${lines.join("\n")}\n`, "utf-8");
    } catch (e) {
      // Audit failure must NOT crash the agent loop.
      process.stderr.write(
        `[frondose] audit writer: failed to append to ${auditPath}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  };
}

/**
 * Direct synchronous audit-row append. Used by tools that cannot rely on
 * `onStepFinish` (e.g. the stop tool — Vercel SDK v4 skips onStepFinish on
 * abort-triggered exits, leaving the stop step's audit row missing). Same
 * JSONL line schema as the `onStepFinish` writer.
 *
 * Failure is non-fatal: stderr-log only. Truncates `output` per TRUNCATE_BYTES.
 */
export function writeAuditRow(auditPath: string, row: AuditEntry): void {
  try {
    const dir = dirname(auditPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const sanitized: AuditEntry = { ...row, input: truncateForAudit(row.input), output: truncateForAudit(row.output) };
    appendFileSync(auditPath, `${JSON.stringify(sanitized)}\n`, "utf-8");
  } catch (e) {
    process.stderr.write(
      `[frondose] writeAuditRow: failed to append to ${auditPath}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

/**
 * P-Y1 workflow event audit. Writes to the same audit.jsonl as tool rows.
 * Backward-compat: tool rows have no `type`; workflow rows use type:"workflow_event".
 */
export function writeWorkflowAudit(auditPath: string, event: WorkflowAuditEntry["event"]): void {
  try {
    const dir = dirname(auditPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const row: WorkflowAuditEntry = { ts: new Date().toISOString(), type: "workflow_event", event };
    appendFileSync(auditPath, `${JSON.stringify(row)}\n`, "utf-8");
  } catch (e) {
    process.stderr.write(
      `[frondose] writeWorkflowAudit: failed to append to ${auditPath}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

/**
 * [P-75 D-25] LLM-call error audit. Pre-D-25, an LLM API failure (bad key → 401,
 * rate limit → 429, network drop, malformed response) was invisible in
 * audit.jsonl — only sidecar stderr saw it, which on Tauri is `/dev/null` at
 * spawn. The operator could not tell "agent did nothing this turn" from "agent's
 * LLM call failed with a 401" without scraping process logs. Now we write a
 * single audit row when the streamText call throws (after filtering out
 * AbortError, which is the normal stop-tool path). Schema is intentionally
 * `type:"llm_error"` to mirror the workflow_event convention and stay
 * backward-compatible with existing audit readers (which assume the absence of
 * `type` means a tool-call row).
 */
export interface LlmErrorAuditRow {
  ts: string;
  type: "llm_error";
  turnId: string;
  errorMessage: string;
  errorName: string;
  /** Free-form: 'manual' | 'auto' | 'magical' | 'workflow_resume' | 'cron'. */
  turnKind: string;
  /** Optional HTTP status if the upstream surfaced one. */
  status?: number;
}
export function writeLlmErrorAudit(auditPath: string, row: Omit<LlmErrorAuditRow, "ts" | "type">): void {
  try {
    const dir = dirname(auditPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const full: LlmErrorAuditRow = { ts: new Date().toISOString(), type: "llm_error", ...row };
    appendFileSync(auditPath, `${JSON.stringify(full)}\n`, "utf-8");
  } catch (e) {
    process.stderr.write(
      `[frondose] writeLlmErrorAudit: failed to append to ${auditPath}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

export function boundedSanitize(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  let remaining = Math.max(0, Math.floor(Number.isFinite(maxBytes) ? maxBytes : 0));
  let truncated = false;
  const seen = new WeakSet<object>();

  const markTruncated = (): string => {
    truncated = true;
    return TRUNCATED_MARKER;
  };

  const spend = (bytes: number): boolean => {
    if (remaining <= 0) {
      truncated = true;
      return false;
    }
    if (bytes > remaining) {
      remaining = 0;
      truncated = true;
      return false;
    }
    remaining -= bytes;
    return true;
  };

  const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

  const sliceToBudget = (text: string, budget: number): string => {
    if (budget <= 0) return "";
    let used = 0;
    let end = 0;
    for (const char of text) {
      const size = byteLength(char);
      if (used + size > budget) break;
      used += size;
      end += char.length;
    }
    return text.slice(0, end);
  };

  const sanitizeString = (text: string): string => {
    const capped = text.length > PER_STRING_CAP ? text.slice(0, PER_STRING_CAP) : text;
    const needsPerStringTruncation = capped.length !== text.length;
    const suffixBytes = needsPerStringTruncation ? byteLength(TRUNCATED_MARKER) : 0;
    const cappedBytes = byteLength(capped) + suffixBytes;
    if (cappedBytes <= remaining) {
      remaining -= cappedBytes;
      if (needsPerStringTruncation) truncated = true;
      return needsPerStringTruncation ? `${capped}${TRUNCATED_MARKER}` : capped;
    }

    truncated = true;
    const available = Math.max(0, remaining - byteLength(TRUNCATED_MARKER));
    remaining = 0;
    return `${sliceToBudget(capped, available)}${TRUNCATED_MARKER}`;
  };

  const sanitizeKey = (key: string): string | null => {
    if (remaining <= 0) return null;
    const capped = key.length > PER_STRING_CAP ? key.slice(0, PER_STRING_CAP) : key;
    const needsPerKeyTruncation = capped.length !== key.length;
    const suffixBytes = needsPerKeyTruncation ? byteLength(TRUNCATED_MARKER) : 0;
    const cappedBytes = byteLength(capped) + suffixBytes + 4;
    if (cappedBytes <= remaining) {
      remaining -= cappedBytes;
      if (needsPerKeyTruncation) truncated = true;
      return needsPerKeyTruncation ? `${capped}${TRUNCATED_MARKER}` : capped;
    }

    truncated = true;
    const available = Math.max(0, remaining - byteLength(TRUNCATED_MARKER) - 4);
    remaining = 0;
    return `${sliceToBudget(capped, available)}${TRUNCATED_MARKER}`;
  };

  const walk = (current: unknown, depth: number): unknown => {
    if (remaining <= 0) return markTruncated();
    if (depth > MAX_DEPTH) return markTruncated();

    if (current === null) {
      return spend(4) ? null : markTruncated();
    }
    if (typeof current === "string") return sanitizeString(current);
    if (typeof current === "number" || typeof current === "boolean") {
      const json = JSON.stringify(current);
      return spend(byteLength(json)) ? current : markTruncated();
    }
    if (typeof current === "undefined") return undefined;
    if (typeof current === "bigint") return sanitizeString(`${current.toString()}n`);
    if (typeof current === "symbol") return sanitizeString(String(current));
    if (typeof current === "function") return "[function]";
    if (typeof current !== "object") return current;

    if (seen.has(current)) {
      truncated = true;
      return CIRCULAR_MARKER;
    }
    if (!spend(2)) return markTruncated();

    seen.add(current);
    try {
      if (Array.isArray(current)) return walkArray(current, depth);
      return walkObject(current as Record<string, unknown>, depth);
    } finally {
      seen.delete(current);
    }
  };

  const walkArray = (current: unknown[], depth: number): unknown[] => {
    const clone: unknown[] = [];
    const limit = Math.min(current.length, MAX_ELEMS);
    for (let index = 0; index < limit; index += 1) {
      if (remaining <= 0) {
        clone.push(markTruncated());
        return clone;
      }

      const key = String(index);
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(current, key);
      } catch {
        clone[index] = UNREADABLE_MARKER;
        truncated = true;
        continue;
      }

      if (!descriptor) {
        clone.length = index + 1;
        continue;
      }
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) {
        clone[index] = GETTER_MARKER;
        truncated = true;
        continue;
      }

      try {
        clone[index] = walk(current[index], depth + 1);
      } catch {
        clone[index] = UNREADABLE_MARKER;
        truncated = true;
      }
    }
    if (current.length > MAX_ELEMS) {
      clone.push(`...[+${current.length - MAX_ELEMS} more]`);
      truncated = true;
    } else {
      clone.length = current.length;
    }
    return clone;
  };

  const walkObject = (current: Record<string, unknown>, depth: number): Record<string, unknown> => {
    const clone: Record<string, unknown> = {};
    let count = 0;

    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue;
      if (count >= MAX_KEYS) {
        clone["...[+1 more]"] = true;
        truncated = true;
        break;
      }
      if (remaining <= 0) {
        clone[TRUNCATED_MARKER] = TRUNCATED_MARKER;
        truncated = true;
        break;
      }

      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(current, key);
      } catch {
        const cloneKey = sanitizeKey(key) ?? TRUNCATED_MARKER;
        clone[cloneKey] = UNREADABLE_MARKER;
        truncated = true;
        count += 1;
        continue;
      }

      if (!descriptor?.enumerable) continue;
      const cloneKey = sanitizeKey(key);
      if (cloneKey === null) {
        clone[TRUNCATED_MARKER] = TRUNCATED_MARKER;
        truncated = true;
        break;
      }
      if (!("value" in descriptor)) {
        clone[cloneKey] = GETTER_MARKER;
        truncated = true;
        count += 1;
        continue;
      }

      try {
        clone[cloneKey] = walk(current[key], depth + 1);
      } catch {
        clone[cloneKey] = UNREADABLE_MARKER;
        truncated = true;
      }
      count += 1;
    }

    return clone;
  };

  return { value: walk(value, 0), truncated };
}

function truncateForAudit(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > TRUNCATE_BYTES ? `${value.slice(0, TRUNCATE_BYTES)}…[truncated]` : value;
  }
  if (value && typeof value === "object") {
    return boundedSanitize(value, TRUNCATE_BYTES).value;
  }
  return value;
}
