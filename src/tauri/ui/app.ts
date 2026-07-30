// P-56a M-1 scaffold + P-Y2.1 Frondose two-mode shell.
// Plain HTML + tsc-compiled TS, no React/Vite. Invokes Rust through window.__TAURI__.

import type { AppMode } from "./mode.js";
import { modeFromState, statusForMode, togglesForMode } from "./mode.js";
import type {
  ButtonElementLike,
  DocumentLike,
  ElementLike,
  InputElementLike,
  TextElementLike,
} from "./render.js";
import { buildSwitcher, renderMarkdownInto } from "./render.js";
import { createSettingsPanel } from "./settings.js";
import { createAppActions } from "./appActions.js";
import { showToast } from "./toast.js";
import { updateSendButtonLabel as updateSendButtonLabelImpl } from "./app/sendButton.js";
import { renderWorkflowCard as renderWorkflowCardImpl } from "./app/workflowCard.js";
import { upsertWorkflowStep as upsertWorkflowStepImpl } from "./app/workflowSteps.js";
import { bindAutoStageButtons as bindAutoStageButtonsImpl } from "./app/autoStageButtons.js";
import { createRunningComposerController } from "./app/runningComposer.js";
import { waitForDoneSse as waitForDoneSseImpl } from "./app/turnSync.js";
import { scrollToBottomIfPinned as scrollToBottomIfPinnedImpl } from "./app/scrolling.js";
import { buildAgentBubble as buildAgentBubbleImpl } from "./app/agentBubble.js";
import { clearThinkingBlock as clearThinkingBlockImpl, rawTextWithBreak as rawTextWithBreakImpl } from "./stepBoundary.js";
import type { LocalizableDocumentLike } from "./i18n.js";
import { localizeDocument, t } from "./i18n.js";

type InvokeFn = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Unlisten = () => void;
type ListenFn = <T>(event: string, handler: (e: { payload: T }) => void) => Promise<Unlisten>;

declare global {
  interface Window {
    __TAURI__?: {
      core: { invoke: InvokeFn };
      event: { listen: ListenFn };
    };
  }
}

type TurnOk = { ok: true; turnId: string };
type TurnErr = { ok: false; reason: string; turnId?: string; attempts?: number };
type TurnResp = TurnOk | TurnErr;
type WorkflowStepState = "pending" | "in_progress" | "completed" | "failed";
type WorkflowStepView = { id: string; title: string; requiresApproval: boolean; state: WorkflowStepState };
type WorkflowView = {
  workflowId: string;
  title: string;
  approvalMode: AppMode;
  steps: WorkflowStepView[];
  pendingStepId: string | null;
  notice: string;
};

type SseFrame =
  | { type: "tool-call"; turnId: string; toolName: string }
  | { type: "text"; turnId: string; chunk: string }
  | { type: "reasoning"; turnId: string; chunk: string }
  | { type: "step-done"; turnId: string; toolNames: string[] }
  | { type: "done"; turnId: string; finishReason: string; aborted?: boolean }
  | { type: "error"; turnId?: string; message: string; retryable?: boolean }
  | { type: "overlay-reconnected" }
  | { type: "overlay-event"; event: unknown }
  | { type: "suggestion-card"; turnId?: string }
  | { type: "next-actions"; turnId?: string }
  | { type: "profile-nav"; profileHandle?: string }
  | { type: "dialog-mode"; dialogMode?: "expand" | "collapse" }
  | { type: "cron-mode"; cronEnabled?: boolean }
  | { type: "passive-mode"; passiveEnabled?: boolean }
  | { type: "cron-tick"; cronRunId: string; taskHint?: string; ts: number }
  | { type: "cron-done"; cronRunId: string; ts: number }
  | { type: "turn-started"; turnId: string; source?: "server" | "cron" }
  | {
      type: "workflow-proposed";
      workflowId: string;
      title: string;
      approvalMode: AppMode;
      steps: WorkflowStepView[];
    }
  | { type: "workflow-step-advanced"; workflowId: string; stepId: string; nextState: WorkflowStepState }
  | { type: "workflow-approval-pending"; workflowId: string; stepId: string; stepTitle: string }
  | { type: "workflow-approval-resolved"; workflowId: string; stepId: string; decision: "approved" | "declined" }
  | { type: "workflow-mode-changed"; workflowId: string; approvalMode: AppMode }
  | { type: "workflow-completed"; workflowId: string; finalState: string }
  | { type: "auto-run-completed"; runId: string; status: "completed" | "stopped_by_agent" | "stopped_by_user" | "blocked"; summary: string | null; finalCounters: Record<string, number>; endedAt: number; ts: number }
  // P-AUTO-ISOLATE: new session-lifecycle frames per plan §4.5 (BE emits these BEFORE
  // the paired `cron-mode` frame).
  | { type: "auto-session-started"; sessionId?: string; prompt?: string; intervalMinutes?: number; ts?: number }
  | { type: "auto-session-completed"; sessionId?: string; reason?: "stop_auto" | "terminated" | "schedule_gone"; ts?: number }
  | { type: "commit-warning"; workflowId: string | null; label: string; severity: "low" };

const windowRef = globalThis as unknown as Window & { document: DocumentLike };

function mustGet<T extends TextElementLike>(id: string): T {
  const el = windowRef.document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as unknown as T;
}

// P0-3: re-write the static en strings in index.html for the detected locale (no-op under en).
localizeDocument(windowRef.document as unknown as LocalizableDocumentLike);

type AppState = "identity-missing" | "idle" | "running" | "error";
let appState: AppState = "identity-missing";
let currentTurnId: string | null = null;
let steerInFlight = false;
let lastTurnPrompt: string | null = null;
let cronEnabled = false;
let passiveEnabled = false;
let appMode: AppMode = "manual";
let workflowView: WorkflowView | null = null;

const nameEl = mustGet<TextElementLike>("name");
const identityGateEl = mustGet<ElementLike>("identity-gate");
const statusEl = mustGet<TextElementLike>("status");
const composerEl = mustGet<ElementLike>("composer");
const commandEl = mustGet<InputElementLike>("command-input");
const sendEl = mustGet<ButtonElementLike>("send-btn");
// P-AUTO-ISOLATE: Terminate button — visible while an Auto session is running so the
// operator can end it. Locked composer means the only Auto-mode composer-strip control
// is Terminate (Send is hidden while auto-session is active).
const autoTerminateEl = mustGet<ButtonElementLike>("auto-terminate");
const modeManualTabEl = mustGet<ButtonElementLike>("mode-manual-tab");
const modeAutoTabEl = mustGet<ButtonElementLike>("mode-auto-tab");
const settingsGearEl = mustGet<ButtonElementLike>("settings-gear");
const tickerEl = mustGet<TextElementLike>("ticker");
const errorBannerEl = mustGet<TextElementLike>("error-banner");
const retryBtnEl = mustGet<ButtonElementLike>("retry-btn");
const cronTickBannerEl = mustGet<TextElementLike>("cron-tick-banner");
const saveToastEl = mustGet<TextElementLike>("save-toast");
const workflowCardEl = mustGet<ElementLike>("workflow-card");
const workflowApproveBtnEl = mustGet<ButtonElementLike>("workflow-approve-btn");
const workflowDeclineBtnEl = mustGet<ButtonElementLike>("workflow-decline-btn");
const workflowHandoffBtnEl = mustGet<ButtonElementLike>("workflow-handoff-btn");
const workflowPauseBtnEl = mustGet<ButtonElementLike>("workflow-pause-btn");
const workflowShowAllBtnEl = mustGet<ButtonElementLike>("workflow-showall-btn");
const autoStageEl = mustGet<ElementLike>("auto-stage");
let workflowExpanded = false;
// P-Y2-MA G1+G2 — conversation list state.
// activeAgentTextEl is the current turn's agent text sink; null between turns.
// scroll-area autoscroll only fires when the user is already near the bottom
// (within AUTOSCROLL_PX) so manual scrollback is not yanked.
let activeAgentTextEl: ElementLike | null = null;
// T-FE-CHAT bug 1: raw (unrendered) answer text for the active bubble, rAF-coalesced re-render.
let activeAgentRawText = "";
let agentRenderScheduled = false;
// [P-THINK] The current turn's gray "thinking" sinks: the wrapper (.agent-thinking, incl. the
// "thinking…" line) and the streamed-reasoning text node. Both null between turns; the whole
// wrapper is removed from the DOM when the turn's output completes ("完成输出后消失").
let activeAgentThinkingWrap: ElementLike | null = null;
let activeAgentThinkingEl: ElementLike | null = null;
let pendingTextBreak = false; // [P-THINK-OVERWRITE] armed by a current-turn step-done; next text chunk gets a paragraph break
const AUTOSCROLL_PX = 100;
const scrollAreaEl = mustGet<ElementLike>("scroll-area");
const conversationListEl = mustGet<ElementLike>("conversation-list");

function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!windowRef.__TAURI__) throw new Error("__TAURI__ missing - not running inside Tauri shell");
  return windowRef.__TAURI__.core.invoke<T>(cmd, args);
}

// Surface a swallowed invoke failure to the operator (error banner) + the devtools
// console, instead of failing silently. Silent catch{} on a user-clicked button is a
// defect: a button that errors is diagnosable; a button that does nothing looks dead.
function surfaceError(label: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[frondose] ${label} failed:`, e);
  errorBannerEl.textContent = t("error.actionFailed", { label, msg });
  errorBannerEl.classList.remove("hidden");
}

// ISSUE-SAVE-MODAL: transient, non-blocking "saved" toast — additive, mirrors surfaceError
// above without touching it. Timer/dismiss logic lives in ./toast.js (sibling, not an app/
// leaf — see toast.ts's doc comment for why).
function surfaceToast(message: string): void {
  showToast(saveToastEl, message);
}

// P-UI-THINK-OVERLAY: isNearBottom/scrollToBottomIfPinned bodies extracted to ./app/scrolling.js
// (800-line cap exhausted; established split pattern). Behavior byte-preserved.
function scrollToBottomIfPinned(): void {
  scrollToBottomIfPinnedImpl(scrollAreaEl, AUTOSCROLL_PX);
}

function appendUserBubble(text: string): void {
  const doc = windowRef.document;
  const bubble = doc.createElement("div") as unknown as ElementLike;
  bubble.classList.add("msg-user");
  bubble.textContent = text;
  conversationListEl.appendChild(bubble);
  scrollToBottomIfPinned();
}

function beginAgentBubble(): void {
  // P-SPLIT-APPTS-LOC: the DOM-construction body (avatar SVG + gray thinking block + answer-text
  // sink) is extracted to app/agentBubble.js — 800-line cap exhausted; established split pattern.
  const refs = buildAgentBubbleImpl(windowRef.document, conversationListEl);
  activeAgentTextEl = refs.textEl;
  activeAgentThinkingWrap = refs.thinkingWrap;
  activeAgentThinkingEl = refs.thinkingTextEl;
  activeAgentRawText = "";
  scrollToBottomIfPinned();
}

// T-FE-CHAT bug 1: coalesce a burst of chunks into <= one parse+DOM-replace per frame. Cast (not a
// bare global ref — the no-DOM-lib main tsconfig also type-checks this file), same idiom as
// scrollAreaEl above.
function scheduleAgentTextRender(): void {
  if (agentRenderScheduled) return;
  agentRenderScheduled = true;
  const raf = (windowRef as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame;
  raf(() => {
    agentRenderScheduled = false;
    if (activeAgentTextEl === null) return; // turn ended before this frame ran
    renderMarkdownInto(windowRef.document, activeAgentTextEl, activeAgentRawText);
    scrollToBottomIfPinned();
  });
}

function appendAgentChunk(chunk: string): void {
  // [BLOCKER-1 fix, 3b round-1] Frame-agnostic: if no active bubble (Manual REPL
  // path — no turn-started SSE per §5.1.0), AUTO-OPEN one. The explicit
  // `beginAgentBubble()` call in the `turn-started` handler (5.1.6) covers the
  // cron/profile-activate/card-action paths; this auto-open is the Manual fallback.
  if (activeAgentTextEl === null) beginAgentBubble();
  if (activeAgentTextEl === null) return; // defensive — beginAgentBubble couldn't allocate (DOM missing)
  // [P-THINK-OVERWRITE] paragraph break between steps' answers (consumed once, never leading).
  if (pendingTextBreak) { pendingTextBreak = false; activeAgentRawText = rawTextWithBreakImpl(activeAgentRawText); }
  activeAgentRawText += chunk;
  scheduleAgentTextRender();
}

// [P-THINK] Append a reasoning delta to the gray thinking block, auto-opening the bubble if the
// turn started without a `turn-started` frame (mirrors appendAgentChunk's Manual-REPL fallback).
function appendReasoningChunk(chunk: string): void {
  if (activeAgentThinkingEl === null) beginAgentBubble();
  if (activeAgentThinkingEl === null || activeAgentThinkingWrap === null) return; // defensive — DOM missing
  activeAgentThinkingWrap.classList.remove("hidden");
  const prev = activeAgentThinkingEl.textContent ?? "";
  activeAgentThinkingEl.textContent = `${prev}${chunk}`;
  scrollToBottomIfPinned();
}

function endAgentBubble(): void {
  if (activeAgentTextEl !== null) renderMarkdownInto(windowRef.document, activeAgentTextEl, activeAgentRawText); // P-FE-MD-HISTORY: flush the pending rAF render BEFORE detach, else the bubble freezes on a stale partial parse
  // [P-THINK] "完成输出后消失" (display:none — ElementLike has no remove(); visually equivalent).
  clearThinkingBlockImpl(activeAgentThinkingWrap, activeAgentThinkingEl);
  activeAgentThinkingWrap = null;
  activeAgentThinkingEl = null;
  activeAgentTextEl = null;
  activeAgentRawText = "";
  pendingTextBreak = false; // [P-THINK-OVERWRITE] reset — no separator leaks into the next bubble
}

function transition(next: AppState): void {
  appState = next;
  // P-ONBOARD-CONVERSATIONAL-IDENTITY: the composer is now available in "identity-missing"
  // too — there must be something to talk INTO on first contact, or a conversational
  // onboarding is structurally impossible. #identity-gate stays visible alongside it as an
  // informational banner (see i18n identity.hint); it retires once any turn completes
  // (transition("idle") on `done`, unconditionally hiding it).
  const composerActive = next === "idle" || next === "running" || next === "identity-missing";
  identityGateEl.classList.toggle("hidden", next !== "identity-missing");
  composerEl.classList.toggle("hidden", !composerActive);
  commandEl.classList.toggle("hidden", !composerActive);
  sendEl.classList.toggle("hidden", !composerActive);
  tickerEl.classList.toggle("hidden", next !== "running");
  errorBannerEl.classList.toggle("hidden", next !== "error");
  commandEl.disabled = !composerActive;
  sendEl.disabled = !composerActive;
  if (next === "idle") {
    sendEl.setAttribute?.("title", t("composer.send"));
    sendEl.classList.remove("is-cancel");
    commandEl.value = "";
    retryBtnEl.classList.add("hidden");
  } else if (next === "running") {
    updateSendButtonLabel();
  }
  // P-AUTO-ISOLATE Step 6 audit fix (LOCKED-4 durability): while an Auto session is live
  // (cronEnabled=true), the generic logic above would re-enable the composer + re-show
  // Send on every cron tick's turn-started/done. Force-hold the Auto-locked UI.
  if (cronEnabled) {
    commandEl.disabled = true;
    sendEl.classList.add("hidden");
    autoTerminateEl.classList.remove("hidden");
  }
}

function updateSendButtonLabel(): void {
  updateSendButtonLabelImpl(commandEl, sendEl, appState === "running");
}

function syncModeUi(mode: AppMode): void {
  appMode = mode;
  buildSwitcher(modeManualTabEl, modeAutoTabEl, mode);
  windowRef.document.documentElement.classList.toggle("mode-auto", mode === "auto");
  windowRef.document.body?.classList.toggle("mode-auto", mode === "auto");
  windowRef.document.documentElement.classList.toggle("mode-magical", mode === "magical");
  windowRef.document.body?.classList.toggle("mode-magical", mode === "magical");
  const status = statusForMode(mode);
  statusEl.textContent = status.label;
  statusEl.classList.toggle("working", mode === "auto");
  // P-Y2-MA G5 desktop: mode-badge text + class flip. Magical uses its badge-only visual hook.
  const modeBadgeEl = windowRef.document.getElementById("mode-badge");
  if (modeBadgeEl) {
    modeBadgeEl.textContent = mode === "auto" ? t("badge.auto") : mode === "magical" ? t("badge.magical") : t("badge.manual");
    modeBadgeEl.setAttribute?.("class", `mode-badge ${mode}`);
  }
  commandEl.setAttribute?.(
    "placeholder",
    mode === "auto" ? t("composer.placeholder.auto") : t("composer.placeholder.manual"),
  );
  renderWorkflowCard();
}

async function applyMode(mode: AppMode): Promise<void> {
  // P-AUTO-ISOLATE §3.2: capture the mode we're leaving so we can revert if the operator
  // clicks "Auto" without a prompt or the BE rejects auto_start.
  const previousMode = appMode;
  // P-AUTO-ISOLATE §3.2 / §6.7: prompt-gated auto-start. Auto tab click without a
  // non-empty prompt surfaces error.autoStartEmpty and reverts the tab; a non-empty
  // prompt drives frondose_agent_auto_start (BE writes the schedule record + flips cron).
  if (mode === "auto") {
    const prompt = commandEl.value.trim();
    if (prompt.length === 0) {
      surfaceError(t("action.setModeCron"), new Error(t("error.autoStartEmpty")));
      syncModeUi(previousMode);
      return;
    }
    try {
      const r = await invoke<{ ok: boolean; sessionId?: string; reason?: string }>(
        "frondose_agent_auto_start",
        { prompt, intervalMinutes: null },
      );
      if (!r.ok) {
        surfaceError(t("action.setModeCron"), new Error(r.reason ?? "unknown"));
        syncModeUi(previousMode);
        return;
      }
      cronEnabled = true;
      commandEl.value = "";
      syncModeUi("auto");
    } catch (e) {
      surfaceError(t("action.setModeCron"), e);
      syncModeUi(previousMode);
    }
    return;
  }
  syncModeUi(mode);
  const toggles = {
    cronEnabled: togglesForMode(mode).cronEnabled,
    passiveEnabled: togglesForMode(mode).passiveEnabled,
  };
  try {
    const cronResp = await invoke<{ ok: boolean; cronEnabled?: boolean }>("frondose_set_cron_mode", {
      enabled: toggles.cronEnabled,
    });
    cronEnabled = cronResp.ok ? (cronResp.cronEnabled ?? toggles.cronEnabled) : toggles.cronEnabled;
  } catch (e) {
    cronEnabled = toggles.cronEnabled;
    surfaceError(t("action.setModeCron"), e);
  }
  try {
    const passiveResp = await invoke<{ ok: boolean; passiveEnabled?: boolean }>("frondose_set_passive_mode", {
      enabled: toggles.passiveEnabled,
    });
    passiveEnabled = passiveResp.ok ? (passiveResp.passiveEnabled ?? toggles.passiveEnabled) : toggles.passiveEnabled;
  } catch (e) {
    passiveEnabled = toggles.passiveEnabled;
    surfaceError(t("action.setModePassive"), e);
  }
  syncModeUi(modeFromState({ cronEnabled, passiveEnabled }));
}

// P-AUTO-ISOLATE Step 5a F1: async action handlers extracted into ./appActions.ts to
// bring app.ts back under CLAUDE.md's 800-line cap. Factory closes over module state
// via the getter/setter callbacks passed here; behavior is byte-preserved. A one-line
// `loadIdentity()` local wrapper below preserves the T-Switcher.3 lexical ordering pin
// (first `loadIdentity()` substring must precede the last `applyMode("manual")`).
const appActions = createAppActions({
  invoke,
  surfaceError,
  document: windowRef.document,
  nameEl,
  errorBannerEl,
  retryBtnEl,
  tickerEl,
  transition,
  setCurrentTurnId: (id) => {
    currentTurnId = id;
  },
  getLastTurnPrompt: () => lastTurnPrompt,
  getWorkflowView: () => workflowView,
});

const loadIdentity = (): Promise<void> => appActions.loadIdentity();
async function abortTurn(): Promise<void> {
  // P-WLC: abort a live turn; otherwise Pause cancels the workflow/Auto run.
  const live = appState === "running" && currentTurnId !== null;
  try {
    if (live) await invoke("frondose_agent_abort");
    else await invoke("frondose_workflow_cancel", { workflowId: workflowView?.workflowId ?? "" });
  } catch (e) {
    surfaceError(t("action.pauseAbort"), e);
  }
}
async function sendCommand(): Promise<void> {
  // P-AUTO-ISOLATE: an Auto-locked composer cannot dispatch even if Enter still fires.
  if (commandEl.disabled) return;
  if (appState === "running" && currentTurnId !== null) {
    const text = commandEl.value.trim();
    if (text.length > 0) {
      await runningComposerController.dispatch(text);
      return;
    }
    await abortTurn();
    return;
  }

  // P-ONBOARD: first-contact turns also dispatch from identity-missing.
  if (appState !== "idle" && appState !== "identity-missing") return;
  const prompt = commandEl.value.trim();
  if (!prompt) return;
  retryBtnEl.classList.add("hidden");
  errorBannerEl.classList.add("hidden");
  try {
    const r = await invoke<TurnResp>("frondose_agent_turn", { prompt });
    if (r.ok === false) {
      errorBannerEl.textContent = t("error.turnRejected", { reason: r.reason });
      transition("error");
      return;
    }
    currentTurnId = r.turnId;
    lastTurnPrompt = prompt;
    appendUserBubble(prompt);
    tickerEl.textContent = t("ticker.starting");
    commandEl.value = ""; // T-FE-CHAT bug 2: clear only on success — preserves input on failure above
    transition("running");
  } catch (e) {
    errorBannerEl.textContent = t("error.invokeFailed", { msg: String(e) });
    transition("error");
  }
}
async function performSteer(newPrompt: string): Promise<void> {
  if (steerInFlight) return;
  if (appState !== "running" || currentTurnId === null) return;
  steerInFlight = true;
  const previousTurnId = currentTurnId;
  try {
    try {
      await invoke("frondose_agent_abort");
    } catch {}
    const completed = await waitForDoneSseImpl(() => currentTurnId, previousTurnId, 3000, 50);
    if (!completed) {
      errorBannerEl.textContent = t("error.steerTimeout");
      // Close the abandoned bubble and reject late frames by dropping its turn id.
      currentTurnId = null;
      endAgentBubble();
      transition("error");
      return;
    }
    const r = await invoke<TurnResp>("frondose_agent_turn", { prompt: newPrompt });
    if (r.ok === false) {
      errorBannerEl.textContent = t("error.steerRejected", { reason: r.reason });
      transition("error");
      return;
    }
    currentTurnId = r.turnId;
    lastTurnPrompt = newPrompt;
    appendUserBubble(newPrompt);
    tickerEl.textContent = t("ticker.starting");
    commandEl.value = ""; // T-FE-CHAT bug 2: clear only once the steer turn is accepted
    transition("running");
  } catch (e) {
    errorBannerEl.textContent = t("error.steerFailed", { msg: String(e) });
    transition("error");
  } finally {
    steerInFlight = false;
  }
}

const runningComposerController = createRunningComposerController({
  invoke,
  steer: (text) => performSteer(text),
  settleStopped: (text) => {
    appendUserBubble(text);
    currentTurnId = null;
    endAgentBubble();
    tickerEl.textContent = t("ticker.done", { reason: "aborted" });
    commandEl.value = "";
    transition("idle");
  },
  reportStopFailure: (error) => {
    surfaceError(t("action.pauseAbort"), error);
  },
});

function bindAutoStageButtons(): void {
  bindAutoStageButtonsImpl(windowRef.document, () => {
    void abortTurn();
  });
}

function renderWorkflowCard(): void {
  renderWorkflowCardImpl(
    { appMode, workflowView, workflowExpanded },
    { document: windowRef.document, workflowCardEl, autoStageEl, bindAutoStageButtons },
  );
}

function upsertWorkflowStep(stepId: string, title: string, state: WorkflowStepState, requiresApproval: boolean): void {
  if (workflowView === null) return;
  upsertWorkflowStepImpl(workflowView, stepId, title, state, requiresApproval);
}

function syncExternalMode(): void {
  syncModeUi(modeFromState({ cronEnabled, passiveEnabled }));
}

function handleEvent(payload: SseFrame): void {
  switch (payload.type) {
    case "tool-call":
      if (payload.turnId === currentTurnId) {
        // P-Y2-MA G4: in Auto mode, the live-action mono format. In Manual, the legacy `${tool}...`.
        const isAuto =
          (windowRef.document.body?.classList as unknown as { contains?: (token: string) => boolean })?.contains?.(
            "mode-auto",
          ) === true;
        tickerEl.textContent = isAuto ? `→ ${payload.toolName}` : `${payload.toolName}...`;
      }
      break;
    case "text":
      if (payload.turnId === currentTurnId) {
        // P-Y2-MA G1: stream into the ACTIVE agent bubble (not a global sink).
        appendAgentChunk(payload.chunk);
      }
      break;
    case "reasoning":
      // [P-THINK] Stream the model's live reasoning into the gray thinking block; it is removed
      // by endAgentBubble() on `done`/`error` ("完成输出后消失").
      if (payload.turnId === currentTurnId) {
        appendReasoningChunk(payload.chunk);
      }
      break;
    case "turn-started":
      // [P-59 FIX-2/3b] Server-initiated turns (resume/card/profile-activate/cron) have no
      // frondose_agent_turn invoke to set currentTurnId, so adopt the announced turn here.
      // P-Y2-MA G1: every turn-started opens a NEW agent bubble; cron/resume turns get one too.
      currentTurnId = payload.turnId;
      beginAgentBubble();
      tickerEl.textContent = payload.source === "cron" ? t("ticker.cronRunning") : t("ticker.starting");
      transition("running");
      break;
    case "step-done":
      // [P-THINK-OVERWRITE] step boundary: clear thinking (next segment OVERWRITES) + arm break. turnId-gated (FM-1 CMR-1).
      if (payload.turnId === currentTurnId) {
        clearThinkingBlockImpl(activeAgentThinkingWrap, activeAgentThinkingEl);
        pendingTextBreak = true;
      }
      break;
    case "done":
      if (payload.turnId === currentTurnId) {
        tickerEl.textContent = t("ticker.done", { reason: payload.finishReason });
        currentTurnId = null;
        // P-Y2-MA G1: close the active agent bubble so the next turn opens a fresh one.
        endAgentBubble();
        if (payload.aborted !== true) {
          retryBtnEl.classList.add("hidden");
          errorBannerEl.classList.add("hidden");
          lastTurnPrompt = null;
        }
        transition("idle");
      }
      break;
    case "error":
      if (payload.turnId !== undefined && payload.turnId !== currentTurnId) break;
      errorBannerEl.textContent = t("error.agent", { msg: payload.message });
      currentTurnId = null;
      endAgentBubble();
      transition("error");
      retryBtnEl.classList.toggle("hidden", payload.retryable !== true);
      break;
    case "overlay-reconnected":
      statusEl.textContent = t("status.overlayReconnected");
      setTimeout(() => {
        statusEl.textContent = statusForMode(appMode).label;
      }, 2000);
      break;
    case "overlay-event":
      break;
    case "suggestion-card":
      statusEl.textContent = t("status.suggestionCard");
      break;
    case "next-actions":
      statusEl.textContent = t("status.nextActions");
      break;
    case "profile-nav":
      statusEl.textContent = t("status.profile", { handle: payload.profileHandle ?? "?" });
      break;
    case "dialog-mode":
      break;
    case "cron-mode":
      cronEnabled = payload.cronEnabled ?? cronEnabled;
      syncExternalMode();
      break;
    case "passive-mode":
      passiveEnabled = payload.passiveEnabled ?? passiveEnabled;
      syncExternalMode();
      break;
    case "cron-tick":
      cronTickBannerEl.textContent = `${t("ticker.cronActive")}${payload.taskHint ? `: ${payload.taskHint}` : ""}`;
      cronTickBannerEl.classList.remove("hidden");
      break;
    case "cron-done":
      cronTickBannerEl.classList.add("hidden");
      cronTickBannerEl.textContent = "";
      break;
    case "workflow-proposed":
      workflowView = {
        workflowId: payload.workflowId,
        title: payload.title,
        approvalMode: payload.approvalMode,
        steps: payload.steps,
        pendingStepId: null,
        notice: "",
      };
      renderWorkflowCard();
      break;
    case "workflow-step-advanced":
      if (workflowView?.workflowId === payload.workflowId) {
        const step = workflowView.steps.find((item) => item.id === payload.stepId);
        if (step) step.state = payload.nextState;
        renderWorkflowCard();
      }
      break;
    case "workflow-approval-pending":
      if (workflowView === null) {
        workflowView = {
          workflowId: payload.workflowId,
          title: t("workflow.defaultTitle"),
          approvalMode: "manual",
          steps: [],
          pendingStepId: null,
          notice: "",
        };
      }
      workflowView.pendingStepId = payload.stepId;
      workflowView.notice = t("workflow.approvalRequired");
      upsertWorkflowStep(payload.stepId, payload.stepTitle, "in_progress", true);
      renderWorkflowCard();
      break;
    case "workflow-approval-resolved":
      if (workflowView?.workflowId === payload.workflowId) {
        workflowView.pendingStepId = null;
        workflowView.notice = payload.decision === "approved" ? t("workflow.approvedResuming") : t("workflow.declined");
        renderWorkflowCard();
      }
      break;
    case "workflow-mode-changed":
      if (workflowView?.workflowId === payload.workflowId) {
        workflowView.approvalMode = payload.approvalMode;
        workflowView.pendingStepId = null;
        workflowView.notice = t("workflow.autoEnabled");
        renderWorkflowCard();
      }
      break;
    case "workflow-completed":
      if (workflowView?.workflowId === payload.workflowId) {
        workflowView = null;
        renderWorkflowCard();
      }
      break;
    case "auto-run-completed":
      // P-WLC: the Auto run closed (agent end_auto_run / cancel / reaper). Finalize the
      // Auto stage to idle via the same close path as workflow-completed. In Auto mode
      // renderWorkflowCard rebuilds the persistent stage with workflowView=null → the
      // idle "Auto is ready" hero. The `done` frame owns the turn lifecycle (currentTurnId).
      workflowView = null;
      renderWorkflowCard();
      break;
    case "auto-session-started":
      // P-AUTO-ISOLATE §4.5 T-FE.LockOnAuto: session went live — lock the composer,
      // reveal Terminate, hide Send. The paired `cron-mode {cronEnabled:true}` frame
      // that follows drives the mode-tab UI via syncExternalMode.
      cronEnabled = true;
      commandEl.disabled = true;
      autoTerminateEl.classList.remove("hidden");
      sendEl.classList.add("hidden");
      break;
    case "auto-session-completed":
      // P-AUTO-ISOLATE §4.5 T-FE.UnlockOnCompleted: session ended (stop_auto / operator
      // terminate / schedule_gone) — unlock the composer, hide Terminate, restore Send,
      // and resync the mode tabs back to Manual (cron off, passive unchanged).
      cronEnabled = false;
      commandEl.disabled = false;
      autoTerminateEl.classList.add("hidden");
      sendEl.classList.remove("hidden");
      syncModeUi(modeFromState({ cronEnabled, passiveEnabled }));
      break;
    case "commit-warning":
      if (workflowView !== null && (payload.workflowId === null || payload.workflowId === workflowView.workflowId)) {
        workflowView.notice = t("workflow.advisoryNotice", { label: payload.label });
        renderWorkflowCard();
      } else {
        statusEl.textContent = t("workflow.advisoryStatus", { label: payload.label });
      }
      break;
  }
}

sendEl.addEventListener("click", () => {
  void sendCommand();
});
// P-AUTO-ISOLATE §3.2 T-FE.TerminateInvokes: Terminate ends the active Auto session;
// the incoming auto-session-completed + cron-mode SSE frames drive the UI back to Manual.
autoTerminateEl.addEventListener("click", () => {
  invoke("frondose_agent_auto_stop").catch((e) => surfaceError(t("action.pauseAbort"), e));
});
retryBtnEl.addEventListener("click", () => {
  void appActions.performRetry();
});
workflowApproveBtnEl.addEventListener("click", () => {
  void appActions.approveWorkflowStep();
});
workflowDeclineBtnEl.addEventListener("click", () => {
  void appActions.declineWorkflowStep();
});
workflowHandoffBtnEl.addEventListener("click", () => {
  void appActions.handoffWorkflow();
});
workflowPauseBtnEl.addEventListener("click", () => {
  void abortTurn();
});
workflowShowAllBtnEl.addEventListener("click", () => {
  workflowExpanded = !workflowExpanded;
  renderWorkflowCard();
});
modeManualTabEl.addEventListener("click", () => {
  void applyMode("manual");
});
modeAutoTabEl.addEventListener("click", () => {
  void applyMode("auto");
});
// P-FIX-MAC-UPDATER-RELAUNCH: inject the Tauri event listener lazily guarded — this module
// constructs the panel BEFORE boot()'s __TAURI__ check, so the closure defers the global
// access to call time and degrades to a no-op unlisten outside the Tauri shell.
const settings = createSettingsPanel({
  invoke,
  surfaceError,
  surfaceToast,
  listen: (event, handler) => {
    if (!windowRef.__TAURI__) return Promise.resolve(() => {});
    return windowRef.__TAURI__.event.listen(event, handler);
  },
  // P-FIX-ICP-STALE-CACHE: a Settings save can change identity/ICP — refresh the home page
  // without requiring a restart.
  onSaved: () => {
    void loadIdentity();
  },
});
settingsGearEl.addEventListener("click", () => {
  settings.open().catch((e) => surfaceError(t("action.openSettings"), e));
});
commandEl.addEventListener("input", () => {
  updateSendButtonLabel();
});
// T-FE-CHAT bug 2: an IME candidate-confirm Enter must not send. isComposing/keyCode-229 is the
// primary guard; commandComposing additionally tracks composition*  directly since WKWebView/
// WebView2 can fire compositionend AFTER the confirming keydown (a race isComposing alone can miss).
let commandComposing = false;
commandEl.addEventListener("compositionstart", () => {
  commandComposing = true;
});
commandEl.addEventListener("compositionend", () => {
  commandComposing = false;
});
commandEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.isComposing !== true && e.keyCode !== 229 && !commandComposing) {
    e.preventDefault();
    void sendCommand();
  }
});

async function boot(): Promise<void> {
  if (!windowRef.__TAURI__) {
    errorBannerEl.textContent = t("error.noTauri");
    transition("error");
    return;
  }
  await windowRef.__TAURI__.event.listen<SseFrame>("overlay-event", (e) => handleEvent(e.payload));
  await appActions.applyLanguagePref();
  await loadIdentity();
  syncModeUi("manual");
}

void boot();
