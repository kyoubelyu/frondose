import { randomBytes } from "node:crypto";
import { soulModeFragment } from "../../../agent/systemPrompt/soul.js";
import { callInOverlay } from "../../../overlay/inject.js";
import { computeCronRunId, findDueJobs, markRan, readSchedule, writeSchedule } from "../../../persistence/schedule.js";
import type { ServeDeps, ServeState } from "./context.js";
import type { createTurnRunner } from "./turn.js";

export function createCronDriver(
  state: ServeState,
  deps: ServeDeps,
  turn: ReturnType<typeof createTurnRunner>,
): {
  tick(): Promise<void>;
} {
  async function tick(): Promise<void> {
    if (!state.cronEnabled) return;
    if (state.currentTurn !== null) return;
    let records: ReturnType<typeof readSchedule>;
    try {
      records = readSchedule(deps.schedulePath);
    } catch {
      return;
    }
    const due = findDueJobs(records, new Date());
    if (due.length === 0) return;
    due.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const next = due[0];
    if (!next) return;
    const fireDate = new Date(next.nextRunAt);
    const cronRunId = computeCronRunId(next, fireDate);
    const localHH = fireDate.getHours().toString().padStart(2, "0");
    const localMM = fireDate.getMinutes().toString().padStart(2, "0");
    const escapeTask = (task: string): string =>
      task.replace(/\\/g, "\\\\").replace(/\r/g, "").replace(/\n/g, " ").replace(/"/g, '\\"');
    const trimmed = next.task.trim();
    const taskLine = trimmed.length > 0 ? `\n(scheduled task: "${escapeTask(trimmed)}")` : "";
    const cronPrompt = `${soulModeFragment("auto")}\n\n[TIME ${localHH}:${localMM}]\n[CRON_RUN_ID=${cronRunId}]${taskLine}`;
    const turnId = randomBytes(4).toString("hex");
    const abortController = new AbortController();
    state.currentTurn = { turnId, abortController };
    deps.emitFrame({ type: "turn-started", turnId, source: "cron" });
    const taskHint = trimmed.length > 0 ? trimmed.slice(0, 60) : undefined;
    deps.emitFrame({
      type: "cron-tick",
      cronRunId,
      taskHint,
      ts: Date.now(),
    });
    const ctxId = state.overlayContextId;
    const client = deps.session.getClient();
    if (ctxId !== undefined && client) {
      void callInOverlay(
        client.handle,
        ctxId,
        `function() { if (window.__maiShowCronBanner) window.__maiShowCronBanner(${JSON.stringify(taskHint ?? "")}); }`,
      );
    }
    state.messages.push({ role: "user", content: cronPrompt });
    // P-57c: cron-fired turns are not retryable in M-1; lastTurnUserPrompt is not set here.
    try {
      await turn.runOneTurn({
        turnId,
        abortController,
        userPrompt: cronPrompt,
        isRetryable: false,
        isCronTurn: true,
      });
      const all = readSchedule(deps.schedulePath);
      const idx = all.findIndex((record) => record.id === next.id);
      if (idx >= 0) {
        const target = all[idx];
        if (target !== undefined) {
          const updated = markRan(target, fireDate);
          if (updated === null) all.splice(idx, 1);
          else all[idx] = updated;
          writeSchedule(deps.schedulePath, all);
        }
      }
    } catch (e) {
      deps.emitFrame({
        type: "error",
        turnId,
        message: e instanceof Error ? e.message : String(e),
        retryable: false,
      });
    } finally {
      state.currentTurn = null;
      deps.emitFrame({ type: "cron-done", cronRunId, ts: Date.now() });
      const doneCtxId = state.overlayContextId;
      const doneClient = deps.session.getClient();
      if (doneCtxId !== undefined && doneClient) {
        void callInOverlay(
          doneClient.handle,
          doneCtxId,
          "function() { if (window.__maiHideCronBanner) window.__maiHideCronBanner(); }",
        );
      }
    }
  }

  return { tick };
}
