// P-AUTO-ISOLATE Step 5a F1: extracted from app.ts (was 861 lines, over CLAUDE.md's
// 800-line cap after the P-AUTO-ISOLATE FE work). This module owns the async action
// handlers that app.ts dispatches (boot-time identity/locale bootstrap; the operator's
// retry/workflow-approve/decline/handoff button clicks). Behavior is byte-preserved
// from the original definitions; deps are injected so app.ts remains the module-state
// owner (`currentTurnId`, `lastTurnPrompt`, `workflowView`).
//
// This is a SIBLING of app.ts (not a leaf under app/) — the app-split-slice11 test
// `S-Importer.1` pins exactly 5 `from "./app/` import lines in app.ts, so a 6th leaf
// would fail that gate. Sibling placement follows the existing precedent of
// `settings.ts` (also a factory-style sibling `createSettingsPanel`).

import type { AppMode } from "./mode.js";
import type {
  ButtonElementLike,
  DocumentLike,
  TextElementLike,
} from "./render.js";
import type { LocalizableDocumentLike } from "./i18n.js";
import { getLocale, localizeDocument, prefToLocale, setLocale, t } from "./i18n.js";

type WorkflowStepState = "pending" | "in_progress" | "completed" | "failed";
interface WorkflowStepView {
  id: string;
  title: string;
  requiresApproval: boolean;
  state: WorkflowStepState;
}
interface WorkflowView {
  workflowId: string;
  title: string;
  approvalMode: AppMode;
  steps: WorkflowStepView[];
  pendingStepId: string | null;
  notice: string;
}

type IdentityOk = { ok: true; fullName?: string; role?: string; company?: string; headline?: string };
type IdentityErr = { ok: false; reason: string };
type IdentityResp = IdentityOk | IdentityErr;
type TurnOk = { ok: true; turnId: string };
type TurnErr = { ok: false; reason: string; turnId?: string; attempts?: number };
type TurnResp = TurnOk | TurnErr;

type AppState = "identity-missing" | "idle" | "running" | "error";

type InvokeFn = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface AppActionsDeps {
  invoke: InvokeFn;
  surfaceError: (label: string, e: unknown) => void;
  document: DocumentLike;
  nameEl: TextElementLike;
  errorBannerEl: TextElementLike;
  retryBtnEl: ButtonElementLike;
  tickerEl: TextElementLike;
  transition: (next: AppState) => void;
  setCurrentTurnId: (id: string | null) => void;
  getLastTurnPrompt: () => string | null;
  getWorkflowView: () => WorkflowView | null;
}

export interface AppActions {
  applyLanguagePref(): Promise<void>;
  loadIdentity(): Promise<void>;
  performRetry(): Promise<void>;
  approveWorkflowStep(): Promise<void>;
  declineWorkflowStep(): Promise<void>;
  handoffWorkflow(): Promise<void>;
}

export function createAppActions(deps: AppActionsDeps): AppActions {
  // P-ZH-1: the module-load localizeDocument() call only knows navigator.language
  // (no settings yet). Once boot() has the operator's persisted language pref, re-flip the
  // chrome locale if the pref picks something other than the auto-detected default.
  async function applyLanguagePref(): Promise<void> {
    try {
      const r = await deps.invoke<{ ok: boolean; language?: "auto" | "en" | "zh" }>("frondose_get_settings");
      if (!r?.ok) return;
      const nextLocale = prefToLocale(r.language ?? "auto");
      if (nextLocale !== getLocale()) {
        setLocale(nextLocale);
        localizeDocument(deps.document as unknown as LocalizableDocumentLike, { force: true });
      }
    } catch (e) {
      // Non-fatal: the chrome stays on its navigator-detected default; don't block boot on this.
      console.error("[frondose] applyLanguagePref failed:", e);
    }
  }

  async function loadIdentity(): Promise<void> {
    try {
      const r = await deps.invoke<IdentityResp>("frondose_identity");
      if (r.ok === false) {
        deps.nameEl.classList.add("error");
        deps.nameEl.textContent = r.reason;
        deps.transition("identity-missing");
        return;
      }
      deps.nameEl.classList.remove("error");
      deps.nameEl.textContent = r.fullName ?? t("identity.noFullName");
      deps.transition("idle");
    } catch (e) {
      deps.nameEl.classList.add("error");
      deps.nameEl.textContent = String(e);
      deps.errorBannerEl.textContent = t("error.boot", { msg: String(e) });
      deps.transition("error");
    }
  }

  async function performRetry(): Promise<void> {
    deps.retryBtnEl.classList.add("hidden");
    deps.errorBannerEl.classList.add("hidden");
    try {
      const r = await deps.invoke<TurnResp>("frondose_agent_retry");
      if (r.ok === false) {
        deps.errorBannerEl.textContent = t("error.retryRejected", { reason: r.reason });
        deps.errorBannerEl.classList.remove("hidden");
        deps.transition("error");
        return;
      }
      deps.setCurrentTurnId(r.turnId);
      // P-Y2-MA: retry does NOT append a new user bubble (prompt already shown);
      // the new agent bubble lands on turn-started just like first-send.
      const lastTurnPrompt = deps.getLastTurnPrompt();
      deps.tickerEl.textContent = lastTurnPrompt === null ? t("ticker.starting") : t("ticker.retrying");
      deps.transition("running");
    } catch (e) {
      deps.errorBannerEl.textContent = t("error.retryInvokeFailed", { msg: String(e) });
      deps.errorBannerEl.classList.remove("hidden");
      deps.transition("error");
    }
  }

  async function approveWorkflowStep(): Promise<void> {
    const workflowView = deps.getWorkflowView();
    if (workflowView?.pendingStepId === null || workflowView === null) return;
    try {
      await deps.invoke("frondose_workflow_approve", { workflowId: workflowView.workflowId, stepId: workflowView.pendingStepId });
    } catch (e) {
      deps.surfaceError(t("action.approve"), e);
    }
  }

  async function declineWorkflowStep(): Promise<void> {
    const workflowView = deps.getWorkflowView();
    if (workflowView?.pendingStepId === null || workflowView === null) return;
    try {
      await deps.invoke("frondose_workflow_decline", {
        workflowId: workflowView.workflowId,
        stepId: workflowView.pendingStepId,
        reason: "operator_declined",
      });
    } catch (e) {
      deps.surfaceError(t("action.decline"), e);
    }
  }

  async function handoffWorkflow(): Promise<void> {
    const workflowView = deps.getWorkflowView();
    if (workflowView === null) return;
    try {
      await deps.invoke("frondose_workflow_handoff", { workflowId: workflowView.workflowId });
    } catch (e) {
      deps.surfaceError(t("action.handoff"), e);
    }
  }

  return {
    applyLanguagePref,
    loadIdentity,
    performRetry,
    approveWorkflowStep,
    declineWorkflowStep,
    handoffWorkflow,
  };
}
