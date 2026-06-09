import type { IncomingMessage, ServerResponse } from "node:http";
import { countAutoLedgerByAction, endAutoRun, getAutoRun } from "../../../../persistence/salesDb.js";
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
  if (url === "/workflow/cancel" && state.autoRunId !== null) {
    const runId = state.autoRunId;
    const db = getSalesDb(deps.salesDbPath);
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
    state.autoRunId = null;
    state.lastEmittedAutoCounters = null;
    state.currentTurn?.abortController.abort();

    const controllerResponse = r.response;
    const controllerSaidNoWorkflow =
      typeof controllerResponse === "object" &&
      controllerResponse !== null &&
      "ok" in controllerResponse &&
      "reason" in controllerResponse &&
      controllerResponse.ok === false &&
      controllerResponse.reason === "no_workflow";
    if (controllerSaidNoWorkflow) {
      sendJson(res, 200, { ok: true, closedAutoRun: true });
      return;
    }
  }
  if (r.resumePrompt) void turn.resumeWorkflowTurn(r.resumePrompt);
  sendJson(res, r.status, r.response);
}
