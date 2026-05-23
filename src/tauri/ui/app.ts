// P-56a M-1 scaffold + P-Y2.1 Frondose two-mode shell.
// Plain HTML + tsc-compiled TS, no React/Vite. Invokes Rust through window.__TAURI__.

import { LOGO_MARK } from "./frondoseTokens.js";
import type { AppMode } from "./mode.js";
import { modeFromToggles, statusForMode, togglesForMode } from "./mode.js";
import {
  buildAutoStage,
  buildBrandBar,
  buildIwfCard,
  buildSwitcher,
  type ButtonElementLike,
  type DocumentLike,
  type ElementLike,
  type InputElementLike,
  type TextElementLike,
} from "./render.js";

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

type IdentityOk = { ok: true; fullName?: string; role?: string; company?: string; headline?: string };
type IdentityErr = { ok: false; reason: string };
type IdentityResp = IdentityOk | IdentityErr;
type ChromeOk = { ok: true; chromePort: number; overlayInstalled: boolean };
type ChromeErr = { ok: false; error: string; message?: string };
type ChromeResp = ChromeOk | ChromeErr;
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
  | { type: "commit-warning"; workflowId: string | null; label: string; severity: "low" };

const windowRef = globalThis as unknown as Window & { document: DocumentLike };

function mustGet<T extends TextElementLike>(id: string): T {
  const el = windowRef.document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as unknown as T;
}

type AppState = "identity-missing" | "chrome-needed" | "idle" | "running" | "error";
let appState: AppState = "chrome-needed";
let currentTurnId: string | null = null;
let steerInFlight = false;
let lastTurnPrompt: string | null = null;
let cronEnabled = false;
let passiveEnabled = false;
let appMode: AppMode = "manual";
let workflowView: WorkflowView | null = null;

const brandBarEl = mustGet<ElementLike>("brand-bar");
const nameEl = mustGet<TextElementLike>("name");
const startEl = mustGet<ButtonElementLike>("start");
const statusEl = mustGet<TextElementLike>("status");
const commandEl = mustGet<InputElementLike>("command-input");
const sendEl = mustGet<ButtonElementLike>("send-btn");
const modeManualTabEl = mustGet<ButtonElementLike>("mode-manual-tab");
const modeAutoTabEl = mustGet<ButtonElementLike>("mode-auto-tab");
const tickerEl = mustGet<TextElementLike>("ticker");
const outputEl = mustGet<TextElementLike>("output");
const errorBannerEl = mustGet<TextElementLike>("error-banner");
const retryBtnEl = mustGet<ButtonElementLike>("retry-btn");
const cronTickBannerEl = mustGet<TextElementLike>("cron-tick-banner");
const workflowCardEl = mustGet<ElementLike>("workflow-card");
const workflowTitleEl = mustGet<TextElementLike>("workflow-title");
const workflowModeEl = mustGet<TextElementLike>("workflow-mode");
const workflowStepsEl = mustGet<ElementLike>("workflow-steps");
const workflowNoticeEl = mustGet<TextElementLike>("workflow-notice");
const workflowApproveBtnEl = mustGet<ButtonElementLike>("workflow-approve-btn");
const workflowDeclineBtnEl = mustGet<ButtonElementLike>("workflow-decline-btn");
const workflowHandoffBtnEl = mustGet<ButtonElementLike>("workflow-handoff-btn");
const autoStageEl = mustGet<ElementLike>("auto-stage");

function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!windowRef.__TAURI__) throw new Error("__TAURI__ missing - not running inside Tauri shell");
  return windowRef.__TAURI__.core.invoke<T>(cmd, args);
}

function transition(next: AppState): void {
  appState = next;
  startEl.classList.toggle("hidden", next !== "chrome-needed");
  commandEl.classList.toggle("hidden", next !== "idle" && next !== "running");
  sendEl.classList.toggle("hidden", next !== "idle" && next !== "running");
  tickerEl.classList.toggle("hidden", next !== "running");
  outputEl.classList.toggle("hidden", next === "identity-missing" || next === "chrome-needed");
  errorBannerEl.classList.toggle("hidden", next !== "error");
  commandEl.disabled = next !== "idle" && next !== "running";
  sendEl.disabled = next !== "idle" && next !== "running";
  if (next === "idle") {
    sendEl.textContent = "Send";
    commandEl.value = "";
    retryBtnEl.classList.add("hidden");
  } else if (next === "running") {
    updateSendButtonLabel();
  }
}

function updateSendButtonLabel(): void {
  if (appState !== "running") return;
  sendEl.textContent = commandEl.value.trim().length > 0 ? "Steer" : "Cancel";
}

function syncModeUi(mode: AppMode): void {
  appMode = mode;
  buildSwitcher(modeManualTabEl, modeAutoTabEl, mode);
  windowRef.document.documentElement.classList.toggle("mode-auto", mode === "auto");
  windowRef.document.body?.classList.toggle("mode-auto", mode === "auto");
  const status = statusForMode(mode);
  statusEl.textContent = status.label;
  statusEl.classList.toggle("working", mode === "auto");
  renderWorkflowCard();
}

async function applyMode(mode: AppMode): Promise<void> {
  syncModeUi(mode);
  const toggles = {
    cronEnabled: togglesForMode(mode).cronEnabled,
    passiveEnabled: togglesForMode(mode).passiveEnabled,
  };
  try {
    const cronResp = await invoke<{ ok: boolean; cronEnabled?: boolean }>("mai_set_cron_mode", {
      enabled: toggles.cronEnabled,
    });
    cronEnabled = cronResp.ok ? (cronResp.cronEnabled ?? toggles.cronEnabled) : toggles.cronEnabled;
  } catch {
    cronEnabled = toggles.cronEnabled;
  }
  try {
    const passiveResp = await invoke<{ ok: boolean; passiveEnabled?: boolean }>("mai_set_passive_mode", {
      enabled: toggles.passiveEnabled,
    });
    passiveEnabled = passiveResp.ok ? (passiveResp.passiveEnabled ?? toggles.passiveEnabled) : toggles.passiveEnabled;
  } catch {
    passiveEnabled = toggles.passiveEnabled;
  }
  syncModeUi(modeFromToggles(cronEnabled));
}

async function loadIdentity(): Promise<void> {
  try {
    const r = await invoke<IdentityResp>("mai_identity");
    if (r.ok === false) {
      nameEl.classList.add("error");
      nameEl.textContent = r.reason;
      transition("identity-missing");
      return;
    }
    nameEl.classList.remove("error");
    nameEl.textContent = r.fullName ?? "(no fullName in identity)";
    transition("chrome-needed");
  } catch (e) {
    nameEl.classList.add("error");
    nameEl.textContent = String(e);
    errorBannerEl.textContent = `boot error: ${String(e)}`;
    transition("error");
  }
}

async function startLinkedIn(): Promise<void> {
  startEl.disabled = true;
  startEl.textContent = "Starting...";
  statusEl.textContent = "";
  try {
    const r = await invoke<ChromeResp>("mai_chrome_ensure");
    if (r.ok === false) {
      statusEl.textContent = `error: ${r.message ?? r.error}`;
      startEl.disabled = false;
      startEl.textContent = "Start LinkedIn";
      return;
    }
    statusEl.textContent = `Chrome on port ${r.chromePort}`;
    transition("idle");
  } catch (e) {
    statusEl.textContent = String(e);
    startEl.disabled = false;
    startEl.textContent = "Start LinkedIn";
  }
}

async function sendCommand(): Promise<void> {
  if (appState === "running" && currentTurnId !== null) {
    const text = commandEl.value.trim();
    if (text.length > 0) {
      void performSteer(text);
      return;
    }
    try {
      await invoke("mai_agent_abort");
    } catch {
      // Best-effort; the SSE error/done event owns UI recovery.
    }
    return;
  }

  if (appState !== "idle") return;
  const prompt = commandEl.value.trim();
  if (!prompt) return;
  retryBtnEl.classList.add("hidden");
  errorBannerEl.classList.add("hidden");
  try {
    const r = await invoke<TurnResp>("mai_agent_turn", { prompt });
    if (r.ok === false) {
      errorBannerEl.textContent = `turn rejected: ${r.reason}`;
      transition("error");
      return;
    }
    currentTurnId = r.turnId;
    lastTurnPrompt = prompt;
    outputEl.textContent = "";
    tickerEl.textContent = "starting...";
    transition("running");
  } catch (e) {
    errorBannerEl.textContent = `invoke failed: ${String(e)}`;
    transition("error");
  }
}

async function waitForDoneSse(targetTurnId: string, timeoutMs = 3000, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (currentTurnId === null || currentTurnId !== targetTurnId) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function performSteer(newPrompt: string): Promise<void> {
  if (steerInFlight) return;
  if (appState !== "running" || currentTurnId === null) return;
  steerInFlight = true;
  const previousTurnId = currentTurnId;
  try {
    try {
      await invoke("mai_agent_abort");
    } catch {
      // The follow-up turn response owns the visible error if abort fails.
    }
    const completed = await waitForDoneSse(previousTurnId, 3000, 50);
    if (!completed) {
      errorBannerEl.textContent = "steer timeout - aborted turn never confirmed";
      transition("error");
      return;
    }
    const r = await invoke<TurnResp>("mai_agent_turn", { prompt: newPrompt });
    if (r.ok === false) {
      errorBannerEl.textContent = `steer resubmit rejected: ${r.reason}`;
      transition("error");
      return;
    }
    currentTurnId = r.turnId;
    lastTurnPrompt = newPrompt;
    outputEl.textContent = "";
    tickerEl.textContent = "starting...";
    transition("running");
  } catch (e) {
    errorBannerEl.textContent = `steer failed: ${String(e)}`;
    transition("error");
  } finally {
    steerInFlight = false;
  }
}

async function performRetry(): Promise<void> {
  retryBtnEl.classList.add("hidden");
  errorBannerEl.classList.add("hidden");
  try {
    const r = await invoke<TurnResp>("mai_agent_retry");
    if (r.ok === false) {
      errorBannerEl.textContent = `retry rejected: ${r.reason}`;
      errorBannerEl.classList.remove("hidden");
      transition("error");
      return;
    }
    currentTurnId = r.turnId;
    outputEl.textContent = "";
    tickerEl.textContent = lastTurnPrompt === null ? "starting..." : "retrying last prompt...";
    transition("running");
  } catch (e) {
    errorBannerEl.textContent = `retry invoke failed: ${String(e)}`;
    errorBannerEl.classList.remove("hidden");
    transition("error");
  }
}

function renderWorkflowCard(): void {
  if (appMode === "auto") {
    workflowCardEl.classList.add("hidden");
    buildAutoStage({ doc: windowRef.document, workflow: workflowView, stage: autoStageEl });
    return;
  }
  autoStageEl.classList.add("hidden");
  if (workflowView === null) {
    workflowCardEl.classList.add("hidden");
    return;
  }
  buildIwfCard({
    doc: windowRef.document,
    workflow: workflowView,
    card: workflowCardEl,
    title: workflowTitleEl,
    mode: workflowModeEl,
    steps: workflowStepsEl,
    notice: workflowNoticeEl,
    approveButton: workflowApproveBtnEl,
    declineButton: workflowDeclineBtnEl,
    handoffButton: workflowHandoffBtnEl,
  });
}

function upsertWorkflowStep(stepId: string, title: string, state: WorkflowStepState, requiresApproval: boolean): void {
  if (workflowView === null) return;
  const existing = workflowView.steps.find((step) => step.id === stepId);
  if (existing) {
    existing.title = title;
    existing.state = state;
    existing.requiresApproval = existing.requiresApproval || requiresApproval;
    return;
  }
  workflowView.steps.push({ id: stepId, title, state, requiresApproval });
}

async function approveWorkflowStep(): Promise<void> {
  if (workflowView?.pendingStepId === null || workflowView === null) return;
  await invoke("mai_workflow_approve", { workflowId: workflowView.workflowId, stepId: workflowView.pendingStepId });
}

async function declineWorkflowStep(): Promise<void> {
  if (workflowView?.pendingStepId === null || workflowView === null) return;
  await invoke("mai_workflow_decline", {
    workflowId: workflowView.workflowId,
    stepId: workflowView.pendingStepId,
    reason: "operator_declined",
  });
}

async function handoffWorkflow(): Promise<void> {
  if (workflowView === null) return;
  await invoke("mai_workflow_handoff", { workflowId: workflowView.workflowId });
}

function syncExternalMode(): void {
  syncModeUi(modeFromToggles(cronEnabled));
}

function handleEvent(payload: SseFrame): void {
  switch (payload.type) {
    case "tool-call":
      if (payload.turnId === currentTurnId) tickerEl.textContent = `${payload.toolName}...`;
      break;
    case "text":
      if (payload.turnId === currentTurnId) outputEl.textContent = `${outputEl.textContent ?? ""}${payload.chunk}`;
      break;
    case "step-done":
      break;
    case "done":
      if (payload.turnId === currentTurnId) {
        tickerEl.textContent = `done (${payload.finishReason})`;
        currentTurnId = null;
        if (payload.aborted !== true) {
          retryBtnEl.classList.add("hidden");
          errorBannerEl.classList.add("hidden");
          lastTurnPrompt = null;
        }
        transition("idle");
      }
      break;
    case "error":
      errorBannerEl.textContent = `agent error: ${payload.message}`;
      currentTurnId = null;
      transition("error");
      retryBtnEl.classList.toggle("hidden", payload.retryable !== true);
      break;
    case "overlay-reconnected":
      statusEl.textContent = "overlay reconnected";
      setTimeout(() => {
        statusEl.textContent = statusForMode(appMode).label;
      }, 2000);
      break;
    case "overlay-event":
      break;
    case "suggestion-card":
      statusEl.textContent = "suggestion card rendered in-page";
      break;
    case "next-actions":
      statusEl.textContent = "next actions rendered in-page";
      break;
    case "profile-nav":
      statusEl.textContent = `profile: ${payload.profileHandle ?? "?"}`;
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
      cronTickBannerEl.textContent = `cron active${payload.taskHint ? `: ${payload.taskHint}` : ""}`;
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
          title: "workflow",
          approvalMode: "manual",
          steps: [],
          pendingStepId: null,
          notice: "",
        };
      }
      workflowView.pendingStepId = payload.stepId;
      workflowView.notice = "Approval required before outbound action.";
      upsertWorkflowStep(payload.stepId, payload.stepTitle, "in_progress", true);
      renderWorkflowCard();
      break;
    case "workflow-approval-resolved":
      if (workflowView?.workflowId === payload.workflowId) {
        workflowView.pendingStepId = null;
        workflowView.notice = payload.decision === "approved" ? "Approved. Resuming workflow." : "Declined.";
        renderWorkflowCard();
      }
      break;
    case "workflow-mode-changed":
      if (workflowView?.workflowId === payload.workflowId) {
        workflowView.approvalMode = payload.approvalMode;
        workflowView.pendingStepId = null;
        workflowView.notice = "Auto mode enabled.";
        renderWorkflowCard();
      }
      break;
    case "workflow-completed":
      if (workflowView?.workflowId === payload.workflowId) {
        workflowView = null;
        renderWorkflowCard();
      }
      break;
    case "commit-warning":
      if (workflowView !== null && (payload.workflowId === null || payload.workflowId === workflowView.workflowId)) {
        workflowView.notice = `Advisory: possible outbound click (${payload.label}).`;
        renderWorkflowCard();
      } else {
        statusEl.textContent = `Advisory: possible outbound click (${payload.label})`;
      }
      break;
  }
}

buildBrandBar(windowRef.document, brandBarEl);
brandBarEl.setAttribute?.("data-logo", LOGO_MARK);

startEl.addEventListener("click", () => {
  void startLinkedIn();
});
sendEl.addEventListener("click", () => {
  void sendCommand();
});
retryBtnEl.addEventListener("click", () => {
  void performRetry();
});
workflowApproveBtnEl.addEventListener("click", () => {
  void approveWorkflowStep();
});
workflowDeclineBtnEl.addEventListener("click", () => {
  void declineWorkflowStep();
});
workflowHandoffBtnEl.addEventListener("click", () => {
  void handoffWorkflow();
});
modeManualTabEl.addEventListener("click", () => {
  void applyMode("manual");
});
modeAutoTabEl.addEventListener("click", () => {
  void applyMode("auto");
});
commandEl.addEventListener("input", () => {
  updateSendButtonLabel();
});
commandEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void sendCommand();
  }
});

async function boot(): Promise<void> {
  if (!windowRef.__TAURI__) {
    errorBannerEl.textContent = "__TAURI__ missing - not running inside Tauri shell";
    transition("error");
    return;
  }
  await windowRef.__TAURI__.event.listen<SseFrame>("overlay-event", (e) => handleEvent(e.payload));
  await loadIdentity();
  await applyMode("manual");
}

void boot();
