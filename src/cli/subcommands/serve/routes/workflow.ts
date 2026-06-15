import type { IncomingMessage, ServerResponse } from "node:http";
import { countAutoLedgerByAction, endAutoRun, getAutoRun, getCurrentAutoRun } from "../../../../persistence/salesDb.js";
import { getSalesDb } from "../../../../tools/sales/_dbHandle.js";
import type { ServeDeps, ServeState } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";
import type { createTurnRunner } from "../turn.js";

export async function handlePostWorkflow(
  state: ServeState,
  deps: ServeDeps,
  turn: ReturnType<typeof createTurnRunner>,
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
): Promise<void> {
  const body = await readJsonBody(req);
  const r = deps.workflow.handleEndpoint(url, body);
  if (url === "/workflow/cancel") {
    // P-AUTO-16 RLS-6: always abort the in-flight turn on cancel — moved OUT of the
    // (now-removed) state.autoRunId conditional. Previously the abort was fenced and
    // never fired for cron-started runs whose in-memory autoRunId pointer was null.
    state.currentTurn?.abortController.abort();

    // P-AUTO-16 RLS-6: re-derive the cancel target from the DB (authoritative) instead
    // of state.autoRunId, so cron-started runs and runs surviving a serve-restart get
    // closed correctly. endAutoRun is idempotent (returns alreadyEnded when endedAt is
    // non-null) — coordinates safely with the P-AUTO-7 reaper and the P-AUTO-12
    // turn-end closer.
    const db = getSalesDb(deps.salesDbPath);
    const current = getCurrentAutoRun(db);
    let closedAutoRun = false;
    if (current !== null) {
      const runId = current.id;
      const counters = countAutoLedgerByAction(db, runId);
      const endResult = endAutoRun(db, runId, {
        status: "stopped_by_user",
        summary: "Cancelled by operator via /workflow/cancel",
        counters,
      });
      if (!endResult.alreadyEnded) {
        const endedRow = getAutoRun(db, runId);
        deps.emitFrame({
          type: "auto-run-completed",
          runId,
          status: "stopped_by_user",
          summary: endedRow?.summary ?? "Cancelled by operator via /workflow/cancel",
          finalCounters: counters,
          endedAt: endedRow?.endedAt ?? Date.now(),
          ts: Date.now(),
        });
      }
      // Round-2 CONCERN #1 fix: closedAutoRun follows the actual mutation result
      // (NOT whether `current !== null`). In an alreadyEnded race (the reaper/cron
      // closed the run between getCurrentAutoRun and endAutoRun), this stays false
      // and the handler falls through to the controller's verbatim no_workflow
      // response — aligned with the emit-guard above.
      closedAutoRun = !endResult.alreadyEnded;
    }
    // Post-effect bookkeeping (no longer the gate).
    state.autoRunId = null;
    state.lastEmittedAutoCounters = null;

    const controllerResponse = r.response;
    const controllerSaidNoWorkflow =
      typeof controllerResponse === "object" &&
      controllerResponse !== null &&
      "ok" in controllerResponse &&
      "reason" in controllerResponse &&
      controllerResponse.ok === false &&
      controllerResponse.reason === "no_workflow";
    if (controllerSaidNoWorkflow && closedAutoRun) {
      sendJson(res, 200, { ok: true, closedAutoRun: true });
      return;
    }
  }
  if (r.resumePrompt) void turn.resumeWorkflowTurn(r.resumePrompt);
  sendJson(res, r.status, r.response);
}
