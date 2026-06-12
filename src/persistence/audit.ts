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
          input: tr.args,
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
    const sanitized: AuditEntry = { ...row, output: truncateForAudit(row.output) };
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

function truncateForAudit(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > TRUNCATE_BYTES ? `${value.slice(0, TRUNCATE_BYTES)}…[truncated]` : value;
  }
  if (value && typeof value === "object") {
    try {
      const json = JSON.stringify(value);
      if (json.length > TRUNCATE_BYTES) return `${json.slice(0, TRUNCATE_BYTES)}…[truncated]`;
      // Returning the original object preserves typing through JSON.stringify in the line.
      return value;
    } catch {
      return "[unserializable]";
    }
  }
  return value;
}
