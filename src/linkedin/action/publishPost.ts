import type { Database as DB } from "better-sqlite3";
import type { WorkflowControllerDeps } from "../../agent/workflow/controller.js";
import { emitCommitWarning } from "../../agent/workflow/runtime/commitWarning.js";
import type { PublishFailReason as ShadowPublishFailReason } from "../../agent/workflow/runtime/deterministicPublishPost.js";
import type { CdpClient } from "../../cdp/client.js";
import { type AuditEntry, writeAuditRow as appendAuditRow } from "../../persistence/audit.js";
import { getDraft, markDraftSent as markDraftSentDefault } from "../../persistence/sales/drafts.js";
import { getSalesDb } from "../../tools/sales/_dbHandle.js";
import { buildOutwardActionAdvice, type OutwardActionAdvice } from "../logic/outwardAction.js";
import { DEFAULT_COMPOSER_LABEL_PATTERN } from "../logic/predicates/composer.js";
import { type ResolveScopedTargetResult, ScopedTargetResolutionError } from "../logic/scopeResolver/shared.js";
import { resolveScopedTarget } from "../logic/scopeResolver/targetResolution.js";
import { captureCurrentSurfaceContext } from "../logic/surface/currentSurface.js";
import { applyTypingPacing } from "../pacing.js";
import type { LinkedinSession } from "../types.js";
import {
  confirmComposerGone,
  ensureInputReady,
  ensureLinkedInDestination,
  ensureTargetReady,
  FillFailedError,
  fillComposerSurface,
  openComposerHardened,
  verifyTypedTextOnSameTarget,
  waitForPostButtonEnabled,
} from "./readiness.js";

const SOURCE = "approval_resume";
const TOOL_NAME = "publish_post_action_runtime";

export interface PublishPostActionDeps {
  session: LinkedinSession;
  client: CdpClient;
  salesDbPath: string;
  auditPath: string;
  workflowDeps: Pick<WorkflowControllerDeps, "emitFrame" | "writeWorkflowAudit">;
  workflowId: string | null;
  stepId: string;
  draftId: string;
  markDraftSent?: (db: DB, id: string) => void;
  writeAuditRow?: (auditPath: string, row: AuditEntry) => void;
  captureCurrentSurfaceContext?: (client: CdpClient) => ReturnType<typeof captureCurrentSurfaceContext>;
}

export type PublishPostActionFailReason =
  | ShadowPublishFailReason
  | "auth_interrupted"
  | "input_resolve_failed"
  | "input_layer_mismatch"
  | "post_resolve_failed"
  | "post_layer_mismatch"
  | "fill_failed"
  | "composer_absent_after_open"
  | "post_button_not_enabled";

export interface PublishPostActionResult {
  published: boolean;
  reason?: PublishPostActionFailReason;
  fallbackAllowed: boolean;
  dispatchAttempted: boolean;
  draftMarkedSent?: boolean;
  accountingError?: string;
  advice?: OutwardActionAdvice[];
  openRound?: number;
  enableGateAttempts?: number;
  composerGoneAttempts?: number;
}

export async function publishApprovedFeedPostViaAction(deps: PublishPostActionDeps): Promise<PublishPostActionResult> {
  const t0 = Date.now();
  let dispatchAttempted = false;
  let enableGateAttempts: number | undefined;
  let composerGoneAttempts: number | undefined;
  if (deps.session.resolvedMode?.() === "auto") {
    return finishPreDispatch(deps, t0, "approval_required", { policy: "auto_post_not_authorized" });
  }
  if (deps.session.inputMode === "hardware") return finishPreDispatch(deps, t0, "hardware_input_not_supported");
  const capture = deps.captureCurrentSurfaceContext ?? captureCurrentSurfaceContext;
  try {
    const draft = getDraft(getSalesDb(deps.salesDbPath), deps.draftId);
    if (!draft) return finishPreDispatch(deps, t0, "draft_missing");
    if (draft.status === "sent") return finishPreDispatch(deps, t0, "draft_already_sent");
    try {
      await ensureLinkedInDestination(deps.client, "feed");
    } catch (e) {
      return finishPreDispatch(deps, t0, "auth_interrupted", { detail: errorMessage(e) });
    }
    const opened = await openComposerHardened({ client: deps.client, capture: () => capture(deps.client) });
    if (!opened.opened) {
      return finishPreDispatch(
        deps,
        t0,
        opened.everClicked ? "composer_absent_after_open" : "composer_open_click_failed",
        { openRound: -1 },
      );
    }
    let inputResolved: ResolveScopedTargetResult;
    try {
      inputResolved = await resolveScopedTarget(
        { kind: "input", scope: "composerInput" },
        {
          captureCurrentSurfaceContext: () => capture(deps.client),
          scopeReadyAttempts: 8,
          scopeReadyRetryMs: 400,
        },
      );
    } catch (e) {
      const reason =
        e instanceof ScopedTargetResolutionError && e.kind === "not_found"
          ? "composer_unavailable"
          : "input_resolve_failed";
      return finishPreDispatch(deps, t0, reason, { detail: errorMessage(e) });
    }
    try {
      await ensureInputReady(inputResolved.context, inputResolved.target);
    } catch (e) {
      return finishPreDispatch(deps, t0, "input_layer_mismatch", { detail: errorMessage(e) });
    }
    await applyTypingPacing(draft.text);
    try {
      await fillComposerSurface(deps.client, DEFAULT_COMPOSER_LABEL_PATTERN, draft.text);
    } catch (e) {
      if (e instanceof FillFailedError) return finishPreDispatch(deps, t0, e.cause, { detail: e.message });
      return finishPreDispatch(deps, t0, "fill_failed", { detail: errorMessage(e) });
    }
    const verified = await verifyTypedTextOnSameTarget(deps.client, DEFAULT_COMPOSER_LABEL_PATTERN, draft.text);
    if (!verified) return finishPreDispatch(deps, t0, "readback_mismatch");
    const enableGate = await waitForPostButtonEnabled(deps.client);
    enableGateAttempts = enableGate.attempts;
    if (!enableGate.enabled) {
      return finishPreDispatch(deps, t0, "post_button_not_enabled", {
        enableGateAttempts: enableGate.attempts,
      });
    }
    let postResolved: ResolveScopedTargetResult;
    try {
      postResolved = await resolveScopedTarget(
        { kind: "button", label: "Post", scope: "composerModal" },
        {
          captureCurrentSurfaceContext: () => capture(deps.client),
          scopeReadyAttempts: 8,
          scopeReadyRetryMs: 400,
        },
      );
    } catch (e) {
      return finishPreDispatch(deps, t0, "post_resolve_failed", { detail: errorMessage(e) });
    }
    try {
      await ensureTargetReady(postResolved.context, postResolved.target);
    } catch (e) {
      return finishPreDispatch(deps, t0, "post_layer_mismatch", { detail: errorMessage(e) });
    }
    dispatchAttempted = true;
    await deps.client.clickAt(postResolved.target.selector);
    const goneCheck = await confirmComposerGone(deps.client);
    composerGoneAttempts = goneCheck.attempts;
    if (!goneCheck.gone) {
      return finishPostDispatchAmbiguous(deps, t0, "composer_still_open", undefined, {
        enableGateAttempts: enableGate.attempts,
        composerGoneAttempts: goneCheck.attempts,
      });
    }
    const advice = buildOutwardActionAdvice("post", postResolved.context, {
      phase: "commit",
      rememberInteraction: "post",
      useIdentityAnchor: true,
    });
    return finishSuccess(deps, t0, advice, {
      openRound: opened.openedOnRound,
      enableGateAttempts: enableGate.attempts,
      composerGoneAttempts: goneCheck.attempts,
    });
  } catch (e) {
    if (dispatchAttempted) {
      return finishPostDispatchAmbiguous(deps, t0, "composer_still_open", `post-dispatch-throw: ${errorMessage(e)}`, {
        ...(enableGateAttempts !== undefined ? { enableGateAttempts } : {}),
        ...(composerGoneAttempts !== undefined ? { composerGoneAttempts } : {}),
      });
    }
    return finishPreDispatch(deps, t0, "internal_error", { detail: errorMessage(e) });
  }
}

type PublishPostActionExtra = Record<string, unknown>;

function finishSuccess(
  deps: PublishPostActionDeps,
  t0: number,
  advice: OutwardActionAdvice[],
  extra?: PublishPostActionExtra,
): PublishPostActionResult {
  const result: PublishPostActionResult = {
    published: true,
    fallbackAllowed: false,
    dispatchAttempted: true,
    draftMarkedSent: false,
    advice,
  };
  applyResultExtra(result, extra);
  try {
    markDraftSent(deps);
    result.draftMarkedSent = true;
  } catch (e) {
    result.accountingError = appendAccountingError(result.accountingError, errorMessage(e));
  }
  try {
    writeRuntimeAudit(deps, t0, { ...result, durationMs: Date.now() - t0 });
  } catch (e) {
    result.accountingError = appendAccountingError(result.accountingError, `writeAuditRow: ${errorMessage(e)}`);
  }
  try {
    emitCommitWarning(deps.workflowDeps, {
      workflowId: deps.workflowId,
      stepId: deps.stepId,
      label: "Post",
      severity: result.accountingError ? "high" : "low",
      accountingError: result.accountingError,
    });
  } catch (e) {
    result.accountingError = appendAccountingError(result.accountingError, `emitCommitWarning: ${errorMessage(e)}`);
  }
  return result;
}

function finishPreDispatch(
  deps: PublishPostActionDeps,
  t0: number,
  reason: PublishPostActionFailReason,
  inputExtra?: PublishPostActionExtra,
): PublishPostActionResult {
  const result: PublishPostActionResult = {
    published: false,
    reason,
    fallbackAllowed: reason !== "approval_required" && reason !== "draft_already_sent",
    dispatchAttempted: false,
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
  deps: PublishPostActionDeps,
  t0: number,
  reason: ShadowPublishFailReason,
  detail?: string,
  extra?: PublishPostActionExtra,
): PublishPostActionResult {
  const result: PublishPostActionResult = {
    published: false,
    reason,
    fallbackAllowed: false,
    dispatchAttempted: true,
    draftMarkedSent: false,
    accountingError: detail,
  };
  applyResultExtra(result, extra);
  try {
    markDraftSent(deps);
    result.draftMarkedSent = true;
  } catch (e) {
    result.accountingError = appendAccountingError(result.accountingError, `markDraftSent: ${errorMessage(e)}`);
  }
  try {
    writeRuntimeAudit(deps, t0, { ...result, durationMs: Date.now() - t0 });
  } catch (e) {
    result.accountingError = appendAccountingError(result.accountingError, `writeAuditRow: ${errorMessage(e)}`);
  }
  try {
    emitCommitWarning(deps.workflowDeps, {
      workflowId: deps.workflowId,
      stepId: deps.stepId,
      label: "Post",
      severity: "high",
      dispatchAmbiguous: true,
      accountingError: result.accountingError,
    });
  } catch (e) {
    result.accountingError = appendAccountingError(result.accountingError, `emitCommitWarning: ${errorMessage(e)}`);
  }
  return result;
}

function applyResultExtra(result: PublishPostActionResult, extra: PublishPostActionExtra | undefined): void {
  if (extra) {
    Object.assign(result, extra);
  }
}

function markDraftSent(deps: PublishPostActionDeps): void {
  (deps.markDraftSent ?? markDraftSentDefault)(getSalesDb(deps.salesDbPath), deps.draftId);
}

function writeRuntimeAudit(
  deps: PublishPostActionDeps,
  t0: number,
  output: Record<string, unknown>,
  inputExtra?: Record<string, unknown>,
): void {
  const write = deps.writeAuditRow ?? appendAuditRow;
  write(deps.auditPath, {
    ts: new Date().toISOString(),
    toolCallId: `runtime_${deps.draftId}_${t0}`,
    toolName: TOOL_NAME,
    input: inputExtra ? { ...auditInput(deps), ...inputExtra } : auditInput(deps),
    output,
    error: null,
    stepFinishReason: "tool-calls",
  });
}

function auditInput(deps: PublishPostActionDeps): Record<string, unknown> {
  return { draftId: deps.draftId, source: SOURCE, workflowId: deps.workflowId, stepId: deps.stepId };
}

function appendAccountingError(current: string | undefined, next: string): string {
  return current ? `${current}; ${next}` : next;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
