import type { WorkflowControllerDeps } from "../../agent/workflow/controller.js";
import { emitCommitWarning } from "../../agent/workflow/runtime/commitWarning.js";
import type { CdpClient } from "../../cdp/client.js";
import { type AuditEntry, writeAuditRow as appendAuditRow } from "../../persistence/audit.js";
import { isLinkedInAuthInterruptionUrl } from "../logic/linkedinUrl.js";
import { buildOutwardActionAdvice, type OutwardActionAdvice } from "../logic/outwardAction.js";
import { type ResolveScopedTargetResult, ScopedTargetResolutionError } from "../logic/scopeResolver/shared.js";
import { resolveScopedTarget } from "../logic/scopeResolver/targetResolution.js";
import { captureCurrentSurfaceContext } from "../logic/surface/currentSurface.js";
import { applyTypingPacing } from "../pacing.js";
import { confirmConnectPromptGone } from "./readiness.js";
import type { LinkedinSession } from "../types.js";

// Slice-3 (native-port): the profile-page connect outbound flow over the Slice-1 logic
// layer, mirroring src/linkedin/action/publishPost.ts. PURE/ADDITIVE — NOT wired into any
// tool yet (Slice 4 wires the tool layer + the outbound guard chain). No child_process.
//
// SCOPE: profile-page connect ONLY. The Network/search personCard:N connect path is
// DEFERRED — production captureCurrentSurfaceContext only emits the `connectPrompt` scope
// for profile-local-overlay surfaces (not network/search), and a network-sidebar
// "Invite X to connect" often sends INSTANTLY with no prompt (memory
// reference-linkedin-invite-quota-and-modals). A sound personCard:N path needs a
// connectPrompt-on-network capture primitive + instant-send handling + live verification
// (quota-blocked); tracked for Slice 4.

const SOURCE = "connect_action_runtime";
const TOOL_NAME = "connect_action_runtime";

// The profile-page action region is exposed as the visible-scope handle "actions"
// (kind "profileActions" — visibleScopeTrusted.ts). The connect prompt overlay is the
// "connectPrompt" visible-scope handle (profile-local-overlay surface only).
const PROFILE_ACTIONS_SCOPE = "actions";
const CONNECT_PROMPT_SCOPE = "connectPrompt";
const CONNECT_LABEL = "Connect";
const MORE_LABEL = "More";
const ADD_NOTE_LABEL = "Add a note";
const SEND_WITHOUT_NOTE_LABEL = "Send without a note";
const SEND_INVITATION_LABEL = "Send invitation";

// Connect opener resolve budget (the profileActions "actions" scope should be present quickly).
const CONNECT_SCOPE_READY_ATTEMPTS = 5;
const CONNECT_SCOPE_READY_RETRY_MS = 250;
// Blueprint §Slice-3 step 4: poll for the connectPrompt scope 5×250ms.
const PROMPT_SCOPE_READY_ATTEMPTS = 5;
const PROMPT_SCOPE_READY_RETRY_MS = 250;

export interface ConnectActionDeps {
  session: LinkedinSession;
  client: CdpClient;
  auditPath: string;
  workflowDeps: Pick<WorkflowControllerDeps, "emitFrame" | "writeWorkflowAudit">;
  workflowId: string | null;
  stepId: string;
  /** Present + non-empty → with-note path; absent → without-note path. */
  note?: string;
  writeAuditRow?: (auditPath: string, row: AuditEntry) => void;
  captureCurrentSurfaceContext?: (client: CdpClient) => ReturnType<typeof captureCurrentSurfaceContext>;
}

export type ConnectActionFailReason =
  | "hardware_input_not_supported"
  | "auth_interrupted"
  | "connect_target_not_found"
  | "more_overflow_failed"
  | "connect_open_click_failed"
  | "connect_prompt_unavailable"
  | "add_note_resolve_failed"
  | "note_input_resolve_failed"
  | "send_resolve_failed"
  | "connect_dispatch_ambiguous"
  | "internal_error";

export interface ConnectActionResult {
  connected: boolean;
  reason?: ConnectActionFailReason;
  fallbackAllowed: boolean;
  dispatchAttempted: boolean;
  withNote: boolean;
  advice?: OutwardActionAdvice[];
  connectOpenClicked?: boolean;
  connectPromptGoneAttempts?: number;
  accountingError?: string;
}

type ConnectActionExtra = Record<string, unknown>;

function scopeReadyBudget(
  captureFor: () => ReturnType<typeof captureCurrentSurfaceContext>,
  attempts: number,
  retryMs: number,
) {
  return { captureCurrentSurfaceContext: captureFor, scopeReadyAttempts: attempts, scopeReadyRetryMs: retryMs };
}

function isNotFound(e: unknown): boolean {
  return e instanceof ScopedTargetResolutionError && e.kind === "not_found";
}

export async function connectViaAction(deps: ConnectActionDeps): Promise<ConnectActionResult> {
  const t0 = Date.now();
  const withNote = typeof deps.note === "string" && deps.note.trim().length > 0;
  let dispatchAttempted = false;
  let connectOpenClicked = false;
  let connectPromptGoneAttempts: number | undefined;

  if (deps.session.inputMode === "hardware") {
    return finishPreDispatch(deps, t0, withNote, "hardware_input_not_supported");
  }

  const capture = deps.captureCurrentSurfaceContext ?? captureCurrentSurfaceContext;
  const captureFor = () => capture(deps.client);

  try {
    // Auth pre-check on the current surface (the caller lands us on the profile / list —
    // connect never navigates to a fixed destination, so there is no ensureLinkedInDestination).
    const initial = await captureFor();
    if (isLinkedInAuthInterruptionUrl(initial.pageUrl)) {
      return finishPreDispatch(deps, t0, withNote, "auth_interrupted");
    }

    // 1. Resolve the Connect opener within the profileActions region ("actions" scope).
    let connectResolved: ResolveScopedTargetResult;
    try {
      connectResolved = await resolveScopedTarget(
        { kind: "button", label: CONNECT_LABEL, scope: PROFILE_ACTIONS_SCOPE },
        scopeReadyBudget(captureFor, CONNECT_SCOPE_READY_ATTEMPTS, CONNECT_SCOPE_READY_RETRY_MS),
      );
    } catch (e) {
      // Connect-under-"More": when the primary profile action is Follow, Connect lives in the
      // overflow menu (memory reference-cdp-unraced-wedge-and-connect-more). Only recover on a
      // clean not_found — any other resolution error is a real failure.
      if (!isNotFound(e)) {
        return finishPreDispatch(deps, t0, withNote, "connect_target_not_found", { detail: errorMessage(e) });
      }
      try {
        const more = await resolveScopedTarget(
          { kind: "button", label: MORE_LABEL, scope: PROFILE_ACTIONS_SCOPE },
          scopeReadyBudget(captureFor, CONNECT_SCOPE_READY_ATTEMPTS, CONNECT_SCOPE_READY_RETRY_MS),
        );
        await deps.client.clickAt(more.target.selector);
      } catch (moreErr) {
        return finishPreDispatch(deps, t0, withNote, "more_overflow_failed", { detail: errorMessage(moreErr) });
      }
      try {
        // Overflow menu items surface as top-level entries (menuitem/link) — resolve without a scope.
        connectResolved = await resolveScopedTarget(
          { kind: "button", label: CONNECT_LABEL },
          scopeReadyBudget(captureFor, CONNECT_SCOPE_READY_ATTEMPTS, CONNECT_SCOPE_READY_RETRY_MS),
        );
      } catch (connectErr) {
        return finishPreDispatch(deps, t0, withNote, "connect_target_not_found", { detail: errorMessage(connectErr) });
      }
    }

    // 2. Click Connect → opens the connect prompt. This is phase "open", NOT an outbound commit,
    //    so the no-double-dispatch latch is NOT set here (the send click below is the commit).
    try {
      await deps.client.clickAt(connectResolved.target.selector);
      connectOpenClicked = true;
    } catch (e) {
      return finishPreDispatch(deps, t0, withNote, "connect_open_click_failed", {
        detail: errorMessage(e),
        connectOpenClicked: false,
      });
    }

    // 3. Poll the connectPrompt scope + resolve the send control.
    let sendResolved: ResolveScopedTargetResult;
    if (withNote) {
      // with-note: Add a note → type into the connectPrompt input → Send invitation.
      let addNote: ResolveScopedTargetResult;
      try {
        addNote = await resolveScopedTarget(
          { kind: "button", label: ADD_NOTE_LABEL, scope: CONNECT_PROMPT_SCOPE },
          scopeReadyBudget(captureFor, PROMPT_SCOPE_READY_ATTEMPTS, PROMPT_SCOPE_READY_RETRY_MS),
        );
      } catch (e) {
        const reason = isNotFound(e) ? "connect_prompt_unavailable" : "add_note_resolve_failed";
        return finishPreDispatch(deps, t0, withNote, reason, { detail: errorMessage(e), connectOpenClicked });
      }
      await deps.client.clickAt(addNote.target.selector);

      let noteInput: ResolveScopedTargetResult;
      try {
        noteInput = await resolveScopedTarget(
          { kind: "input", scope: CONNECT_PROMPT_SCOPE },
          scopeReadyBudget(captureFor, PROMPT_SCOPE_READY_ATTEMPTS, PROMPT_SCOPE_READY_RETRY_MS),
        );
      } catch (e) {
        return finishPreDispatch(deps, t0, withNote, "note_input_resolve_failed", {
          detail: errorMessage(e),
          connectOpenClicked,
        });
      }
      await deps.client.clickAt(noteInput.target.selector); // focus the note field
      await applyTypingPacing(deps.note as string);
      await deps.client.raceHandle(
        deps.client.handle.Input.insertText({ text: deps.note as string }),
        "Input.insertText",
      );

      try {
        sendResolved = await resolveScopedTarget(
          { kind: "button", label: SEND_INVITATION_LABEL, scope: CONNECT_PROMPT_SCOPE },
          scopeReadyBudget(captureFor, PROMPT_SCOPE_READY_ATTEMPTS, PROMPT_SCOPE_READY_RETRY_MS),
        );
      } catch (e) {
        return finishPreDispatch(deps, t0, withNote, "send_resolve_failed", {
          detail: errorMessage(e),
          connectOpenClicked,
        });
      }
    } else {
      // without-note: Send without a note.
      try {
        sendResolved = await resolveScopedTarget(
          { kind: "button", label: SEND_WITHOUT_NOTE_LABEL, scope: CONNECT_PROMPT_SCOPE },
          scopeReadyBudget(captureFor, PROMPT_SCOPE_READY_ATTEMPTS, PROMPT_SCOPE_READY_RETRY_MS),
        );
      } catch (e) {
        const reason = isNotFound(e) ? "connect_prompt_unavailable" : "send_resolve_failed";
        return finishPreDispatch(deps, t0, withNote, reason, { detail: errorMessage(e), connectOpenClicked });
      }
    }

    // 4. Dispatch the outbound invite — single latch set immediately before the one send click.
    dispatchAttempted = true;
    await deps.client.clickAt(sendResolved.target.selector);

    // 5. Post-send confirmation: the connect prompt modal must CLOSE — the proxy that the invite
    //    was actually dispatched (not blocked by a quota wall / error toast). Mirrors the proven
    //    confirmComposerGone gate on the post-publish flow. NO second clickAt is issued — the
    //    single-latch / no-double-send invariant is load-bearing; an unclosed prompt is ambiguous
    //    (an invite may already be sent), NEVER auto-retried.
    const goneCheck = await confirmConnectPromptGone(deps.client);
    connectPromptGoneAttempts = goneCheck.attempts;
    if (!goneCheck.gone) {
      return finishPostDispatchAmbiguous(deps, t0, withNote, "post-send: connect prompt still open", {
        connectOpenClicked,
        connectPromptGoneAttempts: goneCheck.attempts,
      });
    }

    // 6. Commit-phase advice → remember_recommended for the connected person.
    const advice = buildOutwardActionAdvice("connect", sendResolved.context, {
      phase: "commit",
      rememberInteraction: "connect",
    });

    return finishSuccess(deps, t0, withNote, advice, { connectOpenClicked, connectPromptGoneAttempts: goneCheck.attempts });
  } catch (e) {
    if (dispatchAttempted) {
      return finishPostDispatchAmbiguous(deps, t0, withNote, `post-dispatch-throw: ${errorMessage(e)}`, {
        connectOpenClicked,
        ...(connectPromptGoneAttempts !== undefined ? { connectPromptGoneAttempts } : {}),
      });
    }
    return finishPreDispatch(deps, t0, withNote, "internal_error", { detail: errorMessage(e), connectOpenClicked });
  }
}

function finishSuccess(
  deps: ConnectActionDeps,
  t0: number,
  withNote: boolean,
  advice: OutwardActionAdvice[],
  extra?: ConnectActionExtra,
): ConnectActionResult {
  const result: ConnectActionResult = {
    connected: true,
    fallbackAllowed: false,
    dispatchAttempted: true,
    withNote,
    advice,
  };
  applyResultExtra(result, extra);
  try {
    writeRuntimeAudit(deps, t0, { ...result, durationMs: Date.now() - t0 });
  } catch (e) {
    result.accountingError = appendAccountingError(result.accountingError, `writeAuditRow: ${errorMessage(e)}`);
  }
  try {
    emitCommitWarning(deps.workflowDeps, {
      workflowId: deps.workflowId,
      stepId: deps.stepId,
      label: "Connect",
      severity: result.accountingError ? "high" : "low",
      accountingError: result.accountingError,
    });
  } catch (e) {
    result.accountingError = appendAccountingError(result.accountingError, `emitCommitWarning: ${errorMessage(e)}`);
  }
  return result;
}

function finishPreDispatch(
  deps: ConnectActionDeps,
  t0: number,
  withNote: boolean,
  reason: ConnectActionFailReason,
  inputExtra?: ConnectActionExtra,
): ConnectActionResult {
  const result: ConnectActionResult = {
    connected: false,
    reason,
    fallbackAllowed: true,
    dispatchAttempted: false,
    withNote,
  };
  applyResultExtra(result, inputExtra);
  try {
    writeRuntimeAudit(deps, t0, { ...result, durationMs: Date.now() - t0 }, inputExtra);
  } catch (e) {
    result.accountingError = appendAccountingError(result.accountingError, `writeAuditRow: ${errorMessage(e)}`);
  }
  return result;
}

function finishPostDispatchAmbiguous(
  deps: ConnectActionDeps,
  t0: number,
  withNote: boolean,
  detail?: string,
  extra?: ConnectActionExtra,
): ConnectActionResult {
  const result: ConnectActionResult = {
    connected: false,
    reason: "connect_dispatch_ambiguous",
    fallbackAllowed: false,
    dispatchAttempted: true,
    withNote,
    accountingError: detail,
  };
  applyResultExtra(result, extra);
  try {
    writeRuntimeAudit(deps, t0, { ...result, durationMs: Date.now() - t0 });
  } catch (e) {
    result.accountingError = appendAccountingError(result.accountingError, `writeAuditRow: ${errorMessage(e)}`);
  }
  try {
    emitCommitWarning(deps.workflowDeps, {
      workflowId: deps.workflowId,
      stepId: deps.stepId,
      label: "Connect",
      severity: "high",
      dispatchAmbiguous: true,
      accountingError: result.accountingError,
    });
  } catch (e) {
    result.accountingError = appendAccountingError(result.accountingError, `emitCommitWarning: ${errorMessage(e)}`);
  }
  return result;
}

function applyResultExtra(result: ConnectActionResult, extra: ConnectActionExtra | undefined): void {
  if (extra) {
    Object.assign(result, extra);
  }
}

function writeRuntimeAudit(
  deps: ConnectActionDeps,
  t0: number,
  output: Record<string, unknown>,
  inputExtra?: Record<string, unknown>,
): void {
  const write = deps.writeAuditRow ?? appendAuditRow;
  write(deps.auditPath, {
    ts: new Date().toISOString(),
    toolCallId: `runtime_connect_${t0}`,
    toolName: TOOL_NAME,
    input: inputExtra ? { ...auditInput(deps), ...inputExtra } : auditInput(deps),
    output,
    error: null,
    stepFinishReason: "tool-calls",
  });
}

function auditInput(deps: ConnectActionDeps): Record<string, unknown> {
  return {
    source: SOURCE,
    workflowId: deps.workflowId,
    stepId: deps.stepId,
    withNote: typeof deps.note === "string" && deps.note.trim().length > 0,
  };
}

function appendAccountingError(current: string | undefined, next: string): string {
  return current ? `${current}; ${next}` : next;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
