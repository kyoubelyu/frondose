import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
// Type-only import — no child_process import in this file (lint scope).
import type { HookRunner } from "../../agent/hooks.js";
import { ok } from "../../linkedin/envelope.js";
import { writeAuditRow } from "../../persistence/audit.js";

export interface ControlSignals {
  /** Called by stop / escalate tools to request clean agent loop exit. */
  requestStop: () => void;
  /**
   * Path to audit.jsonl. When set, the stop tool writes its own audit row
   * directly via `writeAuditRow` BEFORE `requestStop()` — the Vercel SDK v4
   * skips `onStepFinish` on abort-triggered exits, so the stop step's row
   * would otherwise be missing. (P-6 Step 5a r3.)
   */
  auditPath?: string;
  /**
   * P-54 OQ-1: when `true`, `escalate_for_capability` suppresses the
   * `requestStop()` call (telegram + gh_issue still fire) and returns
   * `stopped: false` so the interactive REPL session stays alive. Mutated
   * per-turn — the interactive operator-turn in `repl.ts` flips this to
   * `true` before `runAgentLoop` and restores to `undefined` in `finally`.
   * Undefined / `false` → F-3 unconditional-stop semantics preserved
   * (cron / telegram / worker / server background paths).
   */
  isInteractive?: boolean;
}

const stopParams = z.object({
  reason: z.string().max(500).optional().describe("Why stopping (logged to audit)."),
});

/**
 * Build the stop tool. The agent calls this when it determines the task is
 * complete or operator says "done". The tool's execute calls control.requestStop()
 * which aborts the AbortController owned by main.ts; the loop sees signal.aborted
 * after the current step finishes and the CLI process.exit(0)s.
 *
 * NEVER calls process.exit(0) inside execute — that would cut off audit / session
 * JSONL writes. The stop signal flows: requestStop → AbortController.abort() →
 * streamText sees signal at next-step boundary → loop returns → main.ts exits.
 *
 * If `control` is undefined (e.g. mock-test environments), the tool installs a
 * no-op stub with a stderr warning so factory construction never fails.
 *
 * P-9 D-12: optional `hookRunner` fires the Stop event hook AFTER the audit row
 * is written and BEFORE `requestStop()` propagates the abort, so operator's
 * Stop hook sees a deterministic "agent halting" signal before the abort cascade.
 */
export function makeStopTool(control: ControlSignals | undefined, hookRunner?: HookRunner) {
  const requestStop =
    control?.requestStop ??
    (() => {
      process.stderr.write(
        "[frondose] stop tool called but control.requestStop is not wired (likely a test environment). No-op.\n",
      );
    });
  return tool({
    description:
      "Stop the agent cleanly. Use when the task is complete or operator says 'done'. " +
      "After this call, the agent flushes audit + session JSONL and exits with status 0.",
    parameters: stopParams,
    execute: async ({ reason }) => {
      const input = { reason };
      const output = ok("stop", { stopped: true, reason });
      // P-6 Step 5a r3: emit audit row directly BEFORE triggering abort.
      // Vercel SDK v4 skips onStepFinish on abort-triggered step exits, so
      // without this direct emit the stop step's audit row would be missing.
      // Other tools continue to be audited via onStepFinish (unchanged).
      if (control?.auditPath) {
        writeAuditRow(control.auditPath, {
          ts: new Date().toISOString(),
          toolCallId: `stop-${randomUUID()}`,
          toolName: "stop",
          input,
          output,
          error: null,
          stepFinishReason: "stop-tool",
        });
      }
      // P-9 D-12: fire Stop event hooks BEFORE the abort cascade begins,
      // so operator's Stop hook sees a deterministic "agent halting" signal.
      if (hookRunner) {
        await hookRunner.runStop({ reason });
      }
      requestStop();
      return output;
    },
  });
}
