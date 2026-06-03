import { randomBytes } from "node:crypto";
import type { StepResult, ToolSet } from "ai";
import { runAgentLoop } from "../../../agent/loop.js";
import { callInOverlay } from "../../../overlay/inject.js";
import type { NextActionsPayload, ServeDeps, ServeState, SuggestionCardPayload } from "./context.js";
import { hideEdgeRing, showEdgeRing } from "./takeover.js";

// [P-75 D-13] Resume turns must NOT re-run task-start ritual or re-qualify; the workflow
// state is preserved across approvals. Block the planning/qualification tools the agent
// reaches for out of habit so it focuses on completing the approved outbound action.
const RESUME_EXCLUDED_TOOLS = new Set([
  "search_memory",
  "getMemory",
  "get_memory_note",
  "suggest_card",
  // task-start ritual / re-qualification habit
  "todo_write",
  "record_raw_candidate",
  "score_lead",
  "score_account",
  "promote_candidate_to_lead",
  "get_lead_context",
  "get_account_context",
  "save_message_draft",
  "list_due_followups",
  "get_sales_report",
]);

export interface TurnArgs {
  turnId: string;
  abortController: AbortController;
  userPrompt: string;
  isRetryable: boolean;
  maxSteps?: number;
  isCronTurn?: boolean;
  isWorkflowResume?: boolean;
}

export function createTurnRunner(
  state: ServeState,
  deps: ServeDeps,
): {
  runOneTurn(args: TurnArgs): Promise<void>;
  triggerAnalyzeProfile(pageUrl: string, turnId: string, abortController: AbortController): Promise<void>;
  steerThenTrigger(newPrompt: string, isWorkflowResume?: boolean): Promise<void>;
  triggerCardActionTurn(actionPrompt: string, isWorkflowResume?: boolean): Promise<void>;
  resumeWorkflowTurn(prompt: string): Promise<void>;
} {
  async function runOneTurn(args: TurnArgs): Promise<void> {
    const { turnId, abortController } = args;
    const ctxId0 = state.overlayContextId;
    const client0 = deps.session.getClient();
    if (ctxId0 !== undefined && client0) {
      void callInOverlay(client0.handle, ctxId0, "function() { window.__maiClearOutput(); }");
    }
    showEdgeRing(state, deps.session); // P-Y2.3: Auto-mode page-edge ring for the turn (no-op in Manual)
    try {
      const activeTools = args.isWorkflowResume
        ? Object.keys(deps.tools).filter((n) => !RESUME_EXCLUDED_TOOLS.has(n))
        : undefined;
      await runAgentLoop({
        model: deps.model,
        system: args.isWorkflowResume ? deps.systemResume : deps.system,
        messages: state.messages,
        tools: deps.tools,
        activeTools,
        maxSteps: args.maxSteps ?? deps.maxSteps,
        abortSignal: abortController.signal,
        onStepFinish: async (step: StepResult<ToolSet>) => {
          await deps.auditWriter(step);
          const toolCalls = step.toolCalls as unknown as Array<{ toolName: string }>;
          const toolResults =
            (step as unknown as { toolResults?: Array<{ toolName: string; result: unknown; args?: unknown }> })
              .toolResults ?? [];
          for (const tr of toolResults) {
            if (tr.toolName === "present_summary") {
              const summary = (tr.result as { ok?: boolean } | null | undefined) ?? {};
              if (summary.ok === true) {
                const ctxId = state.overlayContextId;
                const client = deps.session.getClient();
                if (ctxId !== undefined && client) {
                  const json = JSON.stringify(summary);
                  void callInOverlay(
                    client.handle,
                    ctxId,
                    `function() { window.__maiShowSummaryCard(${JSON.stringify(json)}); }`,
                  );
                }
              }
            }
            if (tr.toolName === "suggest_card") {
              const card = (tr.result as unknown as { ok: boolean }) ?? {};
              deps.emitFrame({ type: "suggestion-card", turnId, card: card as SuggestionCardPayload });
              const ctxId = state.overlayContextId;
              const client = deps.session.getClient();
              if (ctxId !== undefined && client) {
                const json = JSON.stringify(card);
                void callInOverlay(
                  client.handle,
                  ctxId,
                  `function() { window.__maiShowCard(${JSON.stringify(json)}); }`,
                );
              }
            }
            if (tr.toolName === "suggest_next_actions") {
              const nextActions = (tr.result as unknown as { ok: boolean }) ?? {};
              deps.emitFrame({
                type: "next-actions",
                turnId,
                nextActions: nextActions as unknown as NextActionsPayload,
              });
              const ctxId = state.overlayContextId;
              const client = deps.session.getClient();
              if (ctxId !== undefined && client) {
                const json = JSON.stringify(nextActions);
                void callInOverlay(
                  client.handle,
                  ctxId,
                  `function() { window.__maiShowNextActions(${JSON.stringify(json)}); }`,
                );
              }
            }
          }
          const { abort } = deps.workflow.onToolResults(toolResults, { turnId, isCronTurn: args.isCronTurn ?? false });
          if (abort) abortController.abort();
          deps.emitFrame({ type: "step-done", turnId, toolNames: toolCalls.map((call) => call.toolName) });
        },
        onText: (delta) => {
          deps.emitFrame({ type: "text", turnId, chunk: delta });
          const ctxId = state.overlayContextId;
          const client = deps.session.getClient();
          if (ctxId !== undefined && client) {
            const s = JSON.stringify(delta);
            void callInOverlay(client.handle, ctxId, `function() { window.__maiAppendOutput(${JSON.stringify(s)}); }`);
          }
        },
        onToolCall: (toolName) => {
          deps.emitFrame({ type: "tool-call", turnId, toolName });
          const ctxId = state.overlayContextId;
          const client = deps.session.getClient();
          if (ctxId !== undefined && client) {
            const text = JSON.stringify(`mai \xb7 ${toolName}\u2026`);
            void callInOverlay(client.handle, ctxId, `function() { window.__maiUpdateTicker(${text}); }`);
          }
        },
      });

      const finishReason = abortController.signal.aborted ? "aborted" : "stop";
      deps.emitFrame({ type: "done", turnId, finishReason, aborted: abortController.signal.aborted });
      if (!abortController.signal.aborted) {
        state.lastFailedTurnPrompt = null;
        state.retryAttempts = 0;
        const ctxId = state.overlayContextId;
        const client = deps.session.getClient();
        if (ctxId !== undefined && client) {
          void callInOverlay(
            client.handle,
            ctxId,
            'function() { window.__maiUpdateTicker("done"); if (window.__maiHideRetry) window.__maiHideRetry(); }',
          );
        }
      }
    } catch (e) {
      const aborted = abortController.signal.aborted;
      if (aborted) {
        state.lastFailedTurnPrompt = null;
        deps.emitFrame({ type: "done", turnId, finishReason: "aborted", aborted: true });
        return;
      }
      if (args.isRetryable) {
        state.lastFailedTurnPrompt = args.userPrompt;
      } else {
        state.lastFailedTurnPrompt = null;
      }
      const message = e instanceof Error ? e.message : String(e);
      const retryable = state.lastFailedTurnPrompt !== null;
      deps.emitFrame({ type: "error", turnId, message, retryable });
      const ctxId = state.overlayContextId;
      const client = deps.session.getClient();
      if (ctxId !== undefined && client) {
        const messageJson = JSON.stringify(message);
        const fn = retryable
          ? `function() { if (window.__maiShowRetry) window.__maiShowRetry(${messageJson}); }`
          : "function() { if (window.__maiHideRetry) window.__maiHideRetry(); }";
        void callInOverlay(client.handle, ctxId, fn);
      }
    } finally {
      hideEdgeRing(state, deps.session); // P-Y2.3: retract ring + clear cursor/highlight on every turn end
    }
  }

  async function triggerAnalyzeProfile(
    pageUrl: string,
    turnId: string,
    abortController: AbortController,
  ): Promise<void> {
    deps.emitFrame({ type: "turn-started", turnId, source: "server" });
    const analyzePrompt =
      `Operator is on profile ${pageUrl}. Analyze this profile against the operator's ICP. ` +
      "First call `inspect` to extract role/industry/region/companyName from the page. " +
      "Then call `qualify_profile` with those four fields. " +
      "Then call `suggest_card` with: " +
      "(a) when qualified — title (name + role), icpMatch, painChainHypothesis (≤2 sentences), " +
      "painChainStage (one of the 15 methodology enum values), suggestedMove (kind + text); " +
      '(b) when disqualified or extraction failed — {dismissed:true, reason:"..."}. ' +
      "Stop after suggest_card. Do NOT take any outreach action in this sub-turn.";
    state.messages.push({ role: "user", content: analyzePrompt });
    state.lastTurnUserPrompt = analyzePrompt;
    try {
      await runOneTurn({
        turnId,
        abortController,
        userPrompt: analyzePrompt,
        isRetryable: false,
        maxSteps: 20,
        isCronTurn: false,
      });
    } catch (e) {
      deps.emitFrame({
        type: "error",
        turnId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function steerThenTrigger(newPrompt: string, isWorkflowResume = false): Promise<void> {
    if (state.currentTurn === null) {
      void triggerCardActionTurn(newPrompt, isWorkflowResume);
      return;
    }
    const previousTurnId = state.currentTurn.turnId;
    state.currentTurn.abortController.abort();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (state.currentTurn === null || state.currentTurn.turnId !== previousTurnId) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (state.currentTurn !== null && state.currentTurn.turnId === previousTurnId) {
      deps.emitFrame({
        type: "error",
        message: "steer timeout - aborted turn never cleared currentTurn",
      });
      return;
    }
    void triggerCardActionTurn(newPrompt, isWorkflowResume);
  }

  async function triggerCardActionTurn(actionPrompt: string, isWorkflowResume = false): Promise<void> {
    if (state.currentTurn !== null) {
      deps.emitFrame({
        type: "error",
        message: `cannot fire card action - turn ${state.currentTurn.turnId} in progress`,
      });
      return;
    }
    const turnId = randomBytes(4).toString("hex");
    const abortController = new AbortController();
    state.currentTurn = { turnId, abortController };
    deps.emitFrame({ type: "turn-started", turnId, source: "server" });
    state.messages.push({ role: "user", content: actionPrompt });
    state.lastTurnUserPrompt = actionPrompt;
    try {
      await runOneTurn({
        turnId,
        abortController,
        userPrompt: actionPrompt,
        isRetryable: true,
        isCronTurn: false,
        isWorkflowResume,
      });
    } catch (e) {
      deps.emitFrame({
        type: "error",
        turnId,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      state.currentTurn = null;
    }
  }

  async function resumeWorkflowTurn(prompt: string): Promise<void> {
    await steerThenTrigger(prompt, true);
  }

  return {
    runOneTurn,
    triggerAnalyzeProfile,
    steerThenTrigger,
    triggerCardActionTurn,
    resumeWorkflowTurn,
  };
}
