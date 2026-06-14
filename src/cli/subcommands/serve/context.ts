import type { ServerResponse } from "node:http";
import type { CoreMessage } from "ai";
import type { WorkflowController } from "../../../agent/workflow/controller.js";
import type { WorkflowSseFrame } from "../../../agent/workflow/types.js";
import type { OverlayEvent } from "../../../overlay/eventBus.js";
import type { AppMode } from "../../../tauri/ui/mode.js";
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
        | "turn-started"
        | "passive-mode";
      turnId?: string;
      source?: "server" | "cron";
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
  | WorkflowSseFrame
  | {
      type: "auto-run-started";
      runId: string;
      maxDurationMinutes: number;
      maxConnects: number | null;
      startedAt: number;
      ts: number;
    }
  | {
      type: "auto-run-progress";
      runId: string;
      elapsedMinutes: number;
      counters: Record<string, number>;
      ts: number;
    }
  | {
      type: "auto-run-completed";
      runId: string;
      status: "completed" | "stopped_by_agent" | "stopped_by_user" | "blocked";
      summary: string | null;
      finalCounters: Record<string, number>;
      endedAt: number;
      ts: number;
    };

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
  autoRunId: string | null;
  lastEmittedAutoCounters?: Record<string, number> | null;
  // P-AUTO-12 part (b): per-run no-progress tracking — in-memory only.
  // - cronNoProgressRunId: the auto_run id currently being tracked (null
  //   when no run is active). Used to detect a run-id change and reset.
  // - cronNoProgressTurns: consecutive cron ticks against cronNoProgressRunId
  //   that made NO durable funnel progress (per the four-way predicate at
  //   plan §3.2.1) AND were NOT cooldown waits. Closes the run at
  //   resolveCronNoProgressLimit() (default 10).
  cronNoProgressRunId: string | null;
  cronNoProgressTurns: number;
  lastTurnUserPrompt: string | null;
  lastFailedTurnPrompt: string | null;
  retryAttempts: number;
  readonly messages: CoreMessage[];
  readonly passiveProfileCache: Map<string, { ts: number }>;
  readonly passiveLimiter: PassiveRateLimiter;
  readonly sseClients: Set<ServerResponse>;
}

export interface ServeDeps {
  // P-APP-8: null means the LLM was not configured at boot. reloadAgentDeps
  // hydrates this after a successful Settings save; consumers must handle null.
  model: ReturnType<typeof import("../../../agent/modelResolver.js").resolveModel> | null;
  system: string;
  systemResume: string;
  // P-AUTO-8 (M1): per-turn 3-band system composer with the mode-fragment INSIDE Soul.
  // Captures the current soulBandPlain at boot / `reloadAgentDeps` time. Consumed by:
  //   - runOne.ts operator branch (non-cron, non-workflow-resume) with the LIVE mode.
  //   - passive.ts (always Magical context).
  // Cron + workflow-resume turns still use `deps.system` / `deps.systemResume` respectively.
  composeOperatorSystem: (mode: AppMode) => string;
  tools: ReturnType<typeof import("../../../tools/index.js").makeAllTools>;
  maxSteps: number;
  auditWriter: ReturnType<typeof import("../../../persistence/audit.js").makeAuditWriter>;
  session: ReturnType<typeof import("../../../linkedin/session.js").createLinkedinSession>;
  schedulePath: string;
  salesDbPath: string;
  auditPath: string;
  expectedToken: Buffer;
  workflow: WorkflowController;
  emitFrame: (frame: SseFrame) => void;
  emitOverlayEvent: (event: OverlayEvent) => void;
}
