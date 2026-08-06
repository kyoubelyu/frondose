import { randomBytes } from "node:crypto";
import type { OverlayEvent } from "../../overlay/eventBus.js";
import { setCronMode } from "../../persistence/mode.js";
import { MAX_RETRY_ATTEMPTS, type ServeDeps, type ServeState } from "./context.js";
import type { createPassiveHandlers } from "./passive.js";
import type { createTurnRunner } from "./turn.js";
import { clearCurrentTurnIfOwned } from "./turnOwnership.js";

function overlayStringField(event: OverlayEvent, key: string): string | undefined {
  const eventRecord = event as unknown as Record<string, unknown>;
  const payload = event.payload;
  const direct = eventRecord[key];
  if (typeof direct === "string") return direct;
  const fromPayload = payload?.[key];
  return typeof fromPayload === "string" ? fromPayload : undefined;
}

export function createOverlayDispatcher(
  state: ServeState,
  deps: ServeDeps,
  turn: ReturnType<typeof createTurnRunner>,
  passive: ReturnType<typeof createPassiveHandlers>,
): { dispatchOverlayEvent(event: OverlayEvent): void } {
  function dispatchOverlayEvent(event: OverlayEvent): void {
    if (event.event_type === "profile-nav") {
      deps.emitFrame({
        type: "profile-nav",
        profileUrl: overlayStringField(event, "url"),
        profileHandle: overlayStringField(event, "handle"),
      });
      passive.handlePassiveProfileNav(event);
      return;
    }
    if (event.event_type === "observe") {
      passive.handlePassiveObservation(event);
      return;
    }
    if (event.event_type === "activate") {
      const pageUrl = overlayStringField(event, "url");
      if (!pageUrl) return;
      if (state.currentTurn !== null) {
        deps.emitFrame({
          type: "error",
          message: `cannot activate - turn ${state.currentTurn.turnId} in progress`,
        });
        return;
      }
      const turnId = randomBytes(4).toString("hex");
      const abortController = new AbortController();
      state.currentTurn = { turnId, abortController };
      void turn.triggerAnalyzeProfile(pageUrl, turnId, abortController).finally(() => {
        clearCurrentTurnIfOwned(state, turnId);
      });
      return;
    }
    if (event.event_type === "expand-dialog") {
      deps.emitFrame({ type: "dialog-mode", dialogMode: "expand" });
      return;
    }
    if (event.event_type === "retry") {
      if (state.currentTurn !== null) return;
      if (state.lastFailedTurnPrompt === null) return;
      if (state.retryAttempts >= MAX_RETRY_ATTEMPTS) {
        deps.emitFrame({
          type: "error",
          message: `retry limit reached (${state.retryAttempts}/${MAX_RETRY_ATTEMPTS})`,
          retryable: false,
        });
        return;
      }
      const prompt = state.lastFailedTurnPrompt ?? state.lastTurnUserPrompt;
      state.lastFailedTurnPrompt = null;
      state.retryAttempts++;
      void turn.triggerCardActionTurn(prompt);
      return;
    }
    if (event.event_type === "prompt") {
      const text = overlayStringField(event, "text");
      if (!text || text.length === 0) return;
      if (state.currentTurn !== null) {
        void turn.steerThenTrigger(text);
        return;
      }
      void turn.triggerCardActionTurn(text);
      return;
    }
    if (event.event_type === "card-action") {
      const prompt = overlayStringField(event, "prompt");
      if (prompt && prompt.length > 0) {
        void turn.triggerCardActionTurn(prompt);
      }
      return;
    }
    if (
      event.event_type === "workflow-approve" ||
      event.event_type === "workflow-decline" ||
      event.event_type === "workflow-handoff"
    ) {
      const verb = event.event_type.slice("workflow-".length);
      const stepId = overlayStringField(event, "stepId");
      const reason = overlayStringField(event, "reason");
      const r = deps.workflow.handleEndpoint(`/workflow/${verb}`, { stepId, reason });
      if (r.resumePrompt) void turn.resumeWorkflowTurn(r.resumePrompt);
      return;
    }
    if (event.event_type === "mode") {
      const mode = overlayStringField(event, "mode");
      setCronMode(state, mode === "auto");
      deps.emitFrame({ type: "cron-mode", cronEnabled: state.cronEnabled });
      return;
    }
    if (event.event_type === "abort") {
      if (state.currentTurn !== null) state.currentTurn.abortController.abort();
      return;
    }
    deps.emitOverlayEvent(event);
  }

  return { dispatchOverlayEvent };
}
