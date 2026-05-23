import type { ServerResponse } from "node:http";
import type { CoreMessage } from "ai";
import type { WorkflowController } from "../../../agent/workflow/controller.js";
import type { WorkflowSseFrame } from "../../../agent/workflow/types.js";
import type { OverlayEvent } from "../../../overlay/eventBus.js";
import type { PassiveRateLimiter } from "../passiveRateLimit.js";

export const MAX_RETRY_ATTEMPTS = 3;

export type PassiveSkipReason = "rate_limit" | "icp_mismatch" | "cache_hit" | "busy" | "disabled";

export type SseFrame =
  | {
      type:
        | "tool-call"
        | "text"
        | "step-done"
        | "done"
        | "error"
        | "overlay-reconnected"
        | "overlay-event"
        | "suggestion-card"
        | "next-actions"
        | "profile-nav"
        | "dialog-mode"
        | "cron-mode"
        | "cron-tick"
        | "cron-done"
        | "passive-mode";
      turnId?: string;
      toolName?: string;
      toolNames?: string[];
      chunk?: string;
      finishReason?: string;
      aborted?: boolean;
      message?: string;
      retryable?: boolean;
      event?: OverlayEvent;
      card?: SuggestionCardPayload;
      nextActions?: NextActionsPayload;
      profileUrl?: string;
      profileHandle?: string;
      dialogMode?: "expand" | "collapse";
      cronEnabled?: boolean;
      passiveEnabled?: boolean; // P-57g — passive-mode SSE payload
      cronRunId?: string;
      taskHint?: string;
      ts?: number;
    }
  | { type: "passive-fired"; turnId: string; ts: number; reason: string }
  | { type: "passive-skipped"; ts: number; reason: PassiveSkipReason; ctx?: unknown }
  | WorkflowSseFrame;

export interface SuggestionCardPayload {
  dismissed?: boolean;
  reason?: string;
  title?: string;
  icpMatch?: { qualified: boolean; matched: string[]; missing: string[] };
  painChainHypothesis?: string;
  painChainStage?: string;
  suggestedMove?: { kind: "connect" | "comment" | "message"; text: string };
}

export interface NextActionsPayload {
  summary: string;
  actions: Array<{ id: string; label: string; prompt: string; danger?: boolean }>;
}

export interface CurrentTurn {
  turnId: string;
  abortController: AbortController;
}

export type ServeEmitter = import("node:events").EventEmitter<{
  "overlay-event": [OverlayEvent];
  "sse-frame": [SseFrame];
}>;

export interface ServeState {
  currentTurn: CurrentTurn | null;
  overlayContextId: number | undefined;
  unsubscribeContextId: (() => void) | undefined;
  unsubscribeOverlayEvents: (() => void) | undefined;
  cronEnabled: boolean;
  passiveEnabled: boolean;
  lastTurnUserPrompt: string | null;
  lastFailedTurnPrompt: string | null;
  retryAttempts: number;
  readonly messages: CoreMessage[];
  readonly passiveProfileCache: Map<string, { ts: number }>;
  readonly passiveLimiter: PassiveRateLimiter;
  readonly sseClients: Set<ServerResponse>;
}

export interface ServeDeps {
  model: ReturnType<typeof import("../../../agent/modelResolver.js").resolveModel>;
  system: string;
  tools: ReturnType<typeof import("../../../tools/index.js").makeAllTools>;
  maxSteps: number;
  auditWriter: ReturnType<typeof import("../../../persistence/audit.js").makeAuditWriter>;
  session: ReturnType<typeof import("../../../linkedin/session.js").createLinkedinSession>;
  schedulePath: string;
  auditPath: string;
  expectedToken: Buffer;
  workflow: WorkflowController;
  emitFrame: (frame: SseFrame) => void;
  emitOverlayEvent: (event: OverlayEvent) => void;
}
