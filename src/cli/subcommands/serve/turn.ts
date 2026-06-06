import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { StepResult, ToolSet } from "ai";
import { runAgentLoop } from "../../../agent/loop.js";
import { runAgentLoopPi } from "../../../agent/pi/loop.js";
import { callInOverlay } from "../../../overlay/inject.js";
import { writeLlmErrorAudit } from "../../../persistence/audit.js";
import { getCurrentAutoRun } from "../../../persistence/salesDb.js";
import { getSalesDb } from "../../../tools/sales/_dbHandle.js";
import type { NextActionsPayload, ServeDeps, ServeState, SuggestionCardPayload } from "./context.js";
import { hideEdgeRing, showEdgeRing } from "./takeover.js";

// [P-75 D-13 dbg] file-based diagnostic
const TURN_DBG = path.join(os.homedir(), ".mai", "agent", "logs", "turn-debug.log");
function turnDbg(msg: string): void {
  try {
    fs.mkdirSync(path.dirname(TURN_DBG), { recursive: true });
    fs.appendFileSync(TURN_DBG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

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
    // [P-75 P-WEDGE-1] Wire this turn's abort signal into the CDP layer so the D-16
    // cap watcher, the D-27 silent-hang watcher, and operator /agent/abort can
    // interrupt an in-flight (otherwise un-abortable) chrome-remote-interface call.
    // Stored on the session so a client booted mid-turn inherits it; the per-call
    // deadline is the unconditional backstop even before any signal fires. Cleared
    // in finally so a later turn never inherits a stale aborted signal.
    deps.session.setTurnAbortSignal(abortController.signal);
    const ctxId0 = state.overlayContextId;
    const client0 = deps.session.getClient();
    if (ctxId0 !== undefined && client0) {
      void callInOverlay(client0.handle, ctxId0, "function() { window.__maiClearOutput(); }");
    }
    showEdgeRing(state, deps.session); // P-Y2.3: Auto-mode page-edge ring for the turn (no-op in Manual)
    // [P-75 D-16] Runtime-enforced Auto duration cap. Without this, the cap is
    // self-policed by the agent's prompt and only checked before outbound — so an
    // Auto run with maxConnects=0 (discovery-only) never reaches the check and runs
    // past its time budget. Wall-clock watcher: every 15s, if the current auto_run
    // is running AND (now - started_at) >= max_duration_minutes, abort the turn
    // and the controller's salesDb-managed end_auto_run will be called by the agent
    // OR by the next /agent/turn that wraps up an orphan running run (separate
    // cleanup). Watcher self-cancels when the turn ends (clearInterval in finally).
    const capWatcher = setInterval(() => {
      try {
        const db = getSalesDb(deps.salesDbPath);
        const run = getCurrentAutoRun(db);
        if (!run || run.status !== "running") return;
        const elapsedMs = Date.now() - run.startedAt;
        const capMs = run.maxDurationMinutes * 60_000;
        if (elapsedMs >= capMs && !abortController.signal.aborted) {
          deps.emitFrame({
            type: "error",
            turnId,
            message:
              `[auto-run-cap] Duration cap reached: ${Math.round(elapsedMs / 60_000)}min >= ${run.maxDurationMinutes}min cap. ` +
              `Aborting turn. Call end_auto_run({status:"completed", summary:"..."}) on the next opportunity if not already done.`,
          });
          abortController.abort();
        }
      } catch {
        /* watcher must never crash the turn */
      }
    }, 15_000);
    // [P-75 D-27] Turn-level silent-hang detector. Completes the D-25 coverage gap:
    // when the LLM SDK (DeepSeek custom URL via @ai-sdk/openai) silently hangs on a
    // network black hole (DNS retry loop, TCP keepalive stall) without throwing AND
    // without returning finishReason='error', neither D-25's throw-catch path nor the
    // D-22 stalled-detector helps — they need the SDK to either error or finish. A
    // separate progress watcher: track last activity (text chunk or tool call) and if
    // NO progress in 180s, classify the turn as `llm_silent_hang`, write an llm_error
    // audit row, emit an SSE error frame, and abort the controller. Self-cancels on
    // turn end via clearInterval in finally.
    let lastProgressAt = Date.now();
    const noteProgress = (): void => {
      lastProgressAt = Date.now();
    };
    const SILENT_HANG_MS = 180_000;
    const silentHangWatcher = setInterval(() => {
      if (abortController.signal.aborted) return;
      const elapsed = Date.now() - lastProgressAt;
      if (elapsed < SILENT_HANG_MS) return;
      const message =
        `[llm-silent-hang] LLM call made no progress (no text chunk, no tool call) for ${Math.round(elapsed / 1000)}s. ` +
        "Likely cause: SDK hanging on a network black hole (DNS retry, TCP stall, upstream not responding). " +
        "Aborting turn and surfacing as llm_error.";
      turnDbg(`[runOneTurn D-27] turnId=${turnId} silent-hang elapsed=${Math.round(elapsed / 1000)}s — aborting`);
      writeLlmErrorAudit(deps.auditPath, {
        turnId,
        errorMessage: message,
        errorName: "LlmSilentHang",
        turnKind: args.isWorkflowResume ? "workflow_resume" : args.isCronTurn ? "cron" : "operator",
        status: undefined,
      });
      deps.emitFrame({ type: "error", turnId, message });
      abortController.abort();
    }, 30_000);
    try {
      // [P-75 D-23] Filter the `tools` parameter ITSELF instead of using Vercel SDK's
      // experimental_activeTools. Observed in resume turn d13-debug-v2 (2026-06-05):
      // experimental_activeTools is NOT reliably honored by @ai-sdk/openai for the
      // DeepSeek custom-URL provider — the resume turn correctly computed an excluded
      // list including save_message_draft, but the model still SAW + CALLED that tool
      // (and succeeded). Subsetting the tools registry itself is foolproof: the model
      // literally cannot see a tool that isn't in the tools object.
      const filteredTools: ToolSet = args.isWorkflowResume
        ? (Object.fromEntries(Object.entries(deps.tools).filter(([n]) => !RESUME_EXCLUDED_TOOLS.has(n))) as ToolSet)
        : deps.tools;
      // [P-75 D-13 dbg] log the filtered tools count
      // [P-PI Gate 3] Runtime selector — MAI_AGENT_RUNTIME=pi swaps the Vercel loop for the Pi
      // loop (drop-in AgentLoopOpts). Defaults to the Vercel loop so production is unchanged
      // until the Pi path passes its live gates. Both honor abortSignal + raced.ts (loop-agnostic).
      const usePi = process.env.MAI_AGENT_RUNTIME === "pi";
      const runLoop = usePi ? runAgentLoopPi : runAgentLoop;
      turnDbg(
        `[runOneTurn] turnId=${turnId} runtime=${usePi ? "pi" : "vercel"} isWorkflowResume=${args.isWorkflowResume} filteredTools.size=${Object.keys(filteredTools).length} (vs full=${Object.keys(deps.tools).length})`,
      );
      await runLoop({
        model: deps.model,
        system: args.isWorkflowResume ? deps.systemResume : deps.system,
        messages: state.messages,
        tools: filteredTools,
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
          noteProgress(); // [P-75 D-27] feed the silent-hang watcher
          deps.emitFrame({ type: "text", turnId, chunk: delta });
          const ctxId = state.overlayContextId;
          const client = deps.session.getClient();
          if (ctxId !== undefined && client) {
            const s = JSON.stringify(delta);
            void callInOverlay(client.handle, ctxId, `function() { window.__maiAppendOutput(${JSON.stringify(s)}); }`);
          }
        },
        onToolCall: (toolName) => {
          noteProgress(); // [P-75 D-27] feed the silent-hang watcher
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
      // [P-75 D-25 dbg] confirm catch fires + log error shape to turn-debug.log
      turnDbg(
        `[runOneTurn CATCH] turnId=${turnId} aborted=${aborted} errorName=${e instanceof Error ? e.name : "Unknown"} message=${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`,
      );
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
      // [P-75 D-25] Persist the LLM-call error to audit.jsonl. Pre-D-25 these errors
      // (401 bad key / 429 rate limit / network drops / malformed JSON / etc.) were
      // only printed to sidecar stderr — which is /dev/null when the sidecar is
      // launched by Tauri — so the operator could not distinguish "agent did nothing"
      // from "agent's LLM call failed" without scraping process logs. With this row,
      // every operator-facing audit reader (the in-app log panel, downstream analytics,
      // dogfood scripts) sees the failure surfaced as a first-class event.
      const turnKind = args.isWorkflowResume ? "workflow_resume" : args.isCronTurn ? "cron" : "operator";
      // Try to extract an HTTP status from common SDK error shapes (AI SDK propagates
      // upstream status via .status, .statusCode, or .cause.status). Best-effort.
      const errAny = e as { status?: number; statusCode?: number; cause?: { status?: number } } | null;
      const status = errAny?.status ?? errAny?.statusCode ?? errAny?.cause?.status;
      writeLlmErrorAudit(deps.auditPath, {
        turnId,
        errorMessage: message,
        errorName: e instanceof Error ? e.name : "Unknown",
        turnKind,
        status,
      });
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
      clearInterval(capWatcher); // [P-75 D-16] stop the auto-run cap watcher
      clearInterval(silentHangWatcher); // [P-75 D-27] stop the silent-hang watcher
      deps.session.setTurnAbortSignal(undefined); // [P-75 P-WEDGE-1] clear so next turn doesn't inherit a stale aborted signal
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
