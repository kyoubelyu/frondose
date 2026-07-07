import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setCronMode } from "../../../../persistence/mode.js";
import { buildAutoSessionRecord, disableAutoSessionRecords, findActiveAutoSessionId, readSchedule, writeSchedule } from "../../../../persistence/schedule.js";
import { MAX_RETRY_ATTEMPTS, type ServeDeps, type ServeState } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";
import type { createTurnRunner } from "../turn.js";

export async function handlePostAgentTurn(state: ServeState, deps: ServeDeps, turn: ReturnType<typeof createTurnRunner>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // [P-75 D-21] Force-release stuck prior turn before accepting a new one.
  // CDP method calls (Page.navigate, DOM.getBoxModel, Accessibility.getPartialAXTree)
  // returned by chrome-remote-interface don't honor AbortSignal — so a hung CDP call
  // (page never finished loading, AX tree query stalled, etc.) leaves runOneTurn's
  // promise pending forever even after abortController.abort() fires. The `.finally`
  // that clears state.currentTurn never runs, and every subsequent /agent/turn
  // rejects with turn_in_progress until pkill -9. The fix: when /agent/turn is
  // called with state.currentTurn non-null, signal the prior turn AND release the
  // slot immediately. The hung CDP call is now a leaked promise (resolved on sidecar
  // GC) but the operator can dispatch new work. The natural UX: the operator
  // dispatching a NEW prompt clearly wants the new task, even if it interrupts the
  // hung prior one.
  if (state.currentTurn !== null) {
    const stuck = state.currentTurn;
    stuck.abortController.abort();
    state.currentTurn = null;
    deps.emitFrame({
      type: "error",
      turnId: stuck.turnId,
      message: `Turn ${stuck.turnId} force-released by new /agent/turn (D-21: prior turn's tool call did not honor abort).`,
    });
  }
  const body = await readJsonBody(req);
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    sendJson(res, 400, { ok: false, reason: "missing_prompt" });
    return;
  }
  const turnId = randomBytes(4).toString("hex");
  const abortController = new AbortController();
  state.currentTurn = { turnId, abortController };

  // [P-75 D-18] Clear stale workflow state on every fresh top-level operator
  // prompt. Observed in the comment-on-feed-post scenario (2026-06-04): a prior
  // DM workflow's title bled into the new comment task ("Internal DM to Poem
  // Rick + Feed Comment"). Chat history (state.messages) is preserved so the
  // operator can refer back, but the workflow controller's state.current is
  // null'd so any new todo_write declares a fresh plan instead of merging the
  // new task's steps with the prior workflow's title and pending steps.
  // /agent/activate (Magical) and /workflow/approve (resume) deliberately bypass
  // this — resume must keep the workflow it's resuming into.
  const wfState = deps.workflow.getState();
  wfState.current = null;
  wfState.awaitingApprovalStepId = null;

  state.messages.push({ role: "user", content: prompt });
  state.lastTurnUserPrompt = prompt;

  sendJson(res, 200, { ok: true, turnId, status: "queued" });
  void turn
    .runOneTurn({
      turnId,
      abortController,
      userPrompt: prompt,
      isRetryable: true,
      isCronTurn: false,
    })
    .catch((e) => {
      deps.emitFrame({
        type: "error",
        turnId,
        message: e instanceof Error ? e.message : String(e),
      });
    })
    .finally(() => {
      state.currentTurn = null;
    });
}

export async function handlePostAgentActivate(state: ServeState, turn: ReturnType<typeof createTurnRunner>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const pageUrl = typeof body?.url === "string" ? body.url : null;
  if (!pageUrl) {
    sendJson(res, 400, { ok: false, reason: "missing_url" });
    return;
  }
  if (state.currentTurn !== null) {
    sendJson(res, 409, { ok: false, reason: "turn_in_progress", turnId: state.currentTurn.turnId });
    return;
  }
  const turnId = randomBytes(4).toString("hex");
  const abortController = new AbortController();
  state.currentTurn = { turnId, abortController };
  sendJson(res, 200, { ok: true, turnId, status: "queued" });
  void turn.triggerAnalyzeProfile(pageUrl, turnId, abortController).finally(() => {
    state.currentTurn = null;
  });
}

export function handlePostAgentAbort(state: ServeState, res: ServerResponse): void {
  if (state.currentTurn === null) {
    sendJson(res, 200, { ok: false, reason: "not_found" });
    return;
  }
  // [P-75 D-21] Same fix as /agent/turn: signal abort AND release the slot
  // immediately. Don't wait for runOneTurn's promise to settle — if a CDP call
  // is hung, it won't ever settle (chrome-remote-interface doesn't honor
  // AbortSignal). The hung promise becomes a leaked Promise that resolves on
  // sidecar GC. The operator can now /agent/turn again without restart.
  const stuck = state.currentTurn;
  stuck.abortController.abort();
  state.currentTurn = null;
  sendJson(res, 200, { ok: true, turnId: stuck.turnId, released: true });
}

export function handlePostAgentRetry(state: ServeState, turn: ReturnType<typeof createTurnRunner>, res: ServerResponse): void {
  if (state.currentTurn !== null) {
    sendJson(res, 409, { ok: false, reason: "turn_in_progress", turnId: state.currentTurn.turnId });
    return;
  }
  if (state.lastFailedTurnPrompt === null) {
    sendJson(res, 200, { ok: false, reason: "no_failed_turn" });
    return;
  }
  if (state.retryAttempts >= MAX_RETRY_ATTEMPTS) {
    sendJson(res, 200, { ok: false, reason: "retry_limit_reached", attempts: state.retryAttempts });
    return;
  }
  const prompt = state.lastFailedTurnPrompt ?? state.lastTurnUserPrompt;
  state.lastFailedTurnPrompt = null;
  state.retryAttempts++;
  const turnId = randomBytes(4).toString("hex");
  const abortController = new AbortController();
  state.currentTurn = { turnId, abortController };
  state.messages.push({ role: "user", content: prompt });
  state.lastTurnUserPrompt = prompt;
  sendJson(res, 200, { ok: true, turnId, status: "queued", attempts: state.retryAttempts });
  void turn
    .runOneTurn({
      turnId,
      abortController,
      userPrompt: prompt,
      isRetryable: true,
      isCronTurn: false,
    })
    .finally(() => {
      state.currentTurn = null;
    });
}

export async function handlePostCronMode(state: ServeState, deps: ServeDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const enabled = typeof body?.enabled === "boolean" ? body.enabled : null;
  if (enabled === null) {
    sendJson(res, 400, { ok: false, reason: "missing_enabled" });
    return;
  }
  setCronMode(state, enabled);
  deps.emitFrame({ type: "cron-mode", cronEnabled: enabled });
  sendJson(res, 200, { ok: true, cronEnabled: state.cronEnabled });
}

export async function handleAutoStart(state: ServeState, deps: ServeDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    sendJson(res, 400, { ok: false, reason: "missing_prompt" });
    return;
  }

  const intervalRaw = body?.intervalMinutes;
  const intervalMinutes = intervalRaw === undefined || intervalRaw === null ? 15 : intervalRaw;
  if (typeof intervalMinutes !== "number" || !Number.isInteger(intervalMinutes) || intervalMinutes < 15 || intervalMinutes > 1440) {
    sendJson(res, 400, { ok: false, reason: "invalid_interval" });
    return;
  }

  const records = readSchedule(deps.schedulePath);
  const activeSessionId = findActiveAutoSessionId(records);
  if (activeSessionId !== null) {
    sendJson(res, 409, { ok: false, reason: "already_active", sessionId: activeSessionId });
    return;
  }

  const record = buildAutoSessionRecord({ prompt, intervalMinutes, now: new Date() });
  writeSchedule(deps.schedulePath, [...records, record]);
  setCronMode(state, true);
  state.autoSessionId = record.sessionId ?? null;

  deps.emitFrame({
    type: "auto-session-started",
    sessionId: record.sessionId ?? record.id,
    prompt,
    intervalMinutes,
    ts: Date.now(),
  });
  deps.emitFrame({ type: "cron-mode", cronEnabled: true });
  sendJson(res, 200, { ok: true, sessionId: record.sessionId ?? record.id });
}

export function handleAutoStop(state: ServeState, deps: ServeDeps, res: ServerResponse): void {
  const records = readSchedule(deps.schedulePath);
  const { next, disabledCount } = disableAutoSessionRecords(records);
  if (disabledCount > 0) writeSchedule(deps.schedulePath, next);

  setCronMode(state, false);
  state.autoSessionId = null;

  deps.emitFrame({ type: "auto-session-completed", reason: "terminated", ts: Date.now() });
  deps.emitFrame({ type: "cron-mode", cronEnabled: false });
  sendJson(res, 200, { ok: true });
}

export async function handlePostPassiveMode(state: ServeState, deps: ServeDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const enabled = typeof body?.enabled === "boolean" ? body.enabled : null;
  if (enabled === null) {
    sendJson(res, 400, { ok: false, reason: "missing_enabled" });
    return;
  }
  state.passiveEnabled = enabled;
  deps.emitFrame({ type: "passive-mode", passiveEnabled: enabled });
  sendJson(res, 200, { ok: true, passiveEnabled: state.passiveEnabled });
}
