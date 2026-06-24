import type { Database as DB } from "better-sqlite3";
import type { CdpClient } from "../../../cdp/client.js";
import {
  clearFeedComposerEditorLive,
  closeFeedComposerLive,
  composerTextMatches,
  FEED_COMPOSER_LIVE_IN_DOM_JS,
  focusFeedComposerEditorLive,
  getFeedComposerPostButtonCenterLive,
  isFeedComposerPostButtonEnabled,
  READBACK_RETRY_MS,
  triggerStartAPostLive,
} from "../../../linkedin/composerReadiness.js";
import type { LinkedinSession } from "../../../linkedin/types.js";
import { type AuditEntry, writeAuditRow as appendAuditRow } from "../../../persistence/audit.js";
import { getDraft, markDraftSent as markDraftSentDefault } from "../../../persistence/sales/drafts.js";
import { computeCharDelay } from "../../../tools/browser/type.js";
import { getSalesDb } from "../../../tools/sales/_dbHandle.js";
import type { WorkflowControllerDeps } from "../controller.js";
import { emitCommitWarning } from "./commitWarning.js";

const SOURCE = "approval_resume";
const TOOL_NAME = "post_publish_runtime";

export interface PublishPostDeps {
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
}

export type PublishFailReason =
  | "approval_required"
  | "hardware_input_not_supported"
  | "composer_unavailable"
  | "focus_failed"
  | "clear_failed"
  | "readback_mismatch"
  | "post_button_not_enabled"
  | "post_coords_missing"
  | "composer_still_open"
  | "draft_missing"
  | "draft_already_sent"
  | "internal_error";

export interface PublishResult {
  published: boolean;
  reason?: PublishFailReason;
  fallbackAllowed: boolean;
  dispatchAttempted: boolean;
  draftMarkedSent?: boolean;
  accountingError?: string;
}

export async function publishApprovedFeedPost(deps: PublishPostDeps): Promise<PublishResult> {
  const t0 = Date.now();
  let dispatchAttempted = false;

  if (deps.session.resolvedMode?.() === "auto") {
    return finishPreDispatchFailure(deps, t0, "approval_required", { policy: "auto_post_not_authorized" });
  }
  if (deps.session.inputMode === "hardware") {
    return finishPreDispatchFailure(deps, t0, "hardware_input_not_supported");
  }

  try {
    const draft = getDraft(getSalesDb(deps.salesDbPath), deps.draftId);
    if (!draft) return finishPreDispatchFailure(deps, t0, "draft_missing");
    if (draft.status === "sent") return finishPreDispatchFailure(deps, t0, "draft_already_sent");

    let probe = await probeFeedComposerLive(deps.client);
    if (probe.present) {
      const closed = await closeFeedComposerLive(deps.client);
      if (!closed) return finishPreDispatchFailure(deps, t0, "composer_unavailable");
    }

    const opened = await triggerStartAPostLive(deps.client);
    if (!opened) return finishPreDispatchFailure(deps, t0, "composer_unavailable");
    probe = await probeFeedComposerLive(deps.client);
    if (!probe.present) return finishPreDispatchFailure(deps, t0, "composer_unavailable");

    const focused = await focusFeedComposerEditorLive(deps.client);
    if (!focused) return finishPreDispatchFailure(deps, t0, "focus_failed");

    if (probe.editorText.trim() !== "") {
      const cleared = await clearFeedComposerEditorLive(deps.client);
      if (!cleared) return finishPreDispatchFailure(deps, t0, "clear_failed");
    }

    await insertTextHumanLike(deps.client, draft.text);

    let after = await probeFeedComposerLive(deps.client);
    let matched = after.present && composerTextMatches(draft.text, after.editorText);
    if (!matched) {
      await sleep(READBACK_RETRY_MS);
      after = await probeFeedComposerLive(deps.client);
      matched = after.present && composerTextMatches(draft.text, after.editorText);
    }
    if (!matched) return finishPreDispatchFailure(deps, t0, "readback_mismatch");

    let enabled = await isFeedComposerPostButtonEnabled(deps.client);
    if (!enabled) {
      await sleep(READBACK_RETRY_MS);
      enabled = await isFeedComposerPostButtonEnabled(deps.client);
    }
    if (!enabled) return finishPreDispatchFailure(deps, t0, "post_button_not_enabled");

    const coords = await getFeedComposerPostButtonCenterLive(deps.client);
    if (!coords) return finishPreDispatchFailure(deps, t0, "post_coords_missing");

    dispatchAttempted = true;
    await deps.client.dispatchHumanLikeClickAtCoords(coords.x, coords.y);

    await sleep(READBACK_RETRY_MS);
    let gone = !(await probeFeedComposerLive(deps.client)).present;
    if (!gone) {
      await sleep(READBACK_RETRY_MS);
      gone = !(await probeFeedComposerLive(deps.client)).present;
    }
    if (!gone) return finishPostDispatchAmbiguous(deps, t0, "composer_still_open");

    return finishSuccess(deps, t0);
  } catch (e) {
    if (dispatchAttempted) {
      return finishPostDispatchAmbiguous(deps, t0, "composer_still_open", `post-dispatch-throw: ${errorMessage(e)}`);
    }
    return finishPreDispatchFailure(deps, t0, "internal_error", { detail: errorMessage(e) });
  }
}

async function insertTextHumanLike(client: CdpClient, text: string): Promise<void> {
  let prevChar: string | undefined;
  let elapsed = 0;
  for (const ch of text) {
    if (ch === "\n") {
      await client.raceHandle(
        client.handle.Input.dispatchKeyEvent({
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        }),
        "Input.keyDown",
      );
      await client.raceHandle(
        client.handle.Input.dispatchKeyEvent({
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        }),
        "Input.keyUp",
      );
    } else {
      await client.raceHandle(client.handle.Input.insertText({ text: ch }), "Input.insertText");
    }
    const raw = computeCharDelay(text.length, Math.random(), prevChar);
    const delay = Math.min(raw, Math.max(0, 8000 - elapsed));
    elapsed += delay;
    await sleep(delay);
    prevChar = ch;
  }
}

async function probeFeedComposerLive(client: CdpClient): Promise<{ present: boolean; editorText: string }> {
  const raw = await client.evaluate<string>(FEED_COMPOSER_LIVE_IN_DOM_JS);
  const parsed = JSON.parse(raw) as { present?: boolean; editorText?: string };
  return parsed.present === true
    ? { present: true, editorText: typeof parsed.editorText === "string" ? parsed.editorText : "" }
    : { present: false, editorText: "" };
}

function finishSuccess(deps: PublishPostDeps, t0: number): PublishResult {
  let draftMarkedSent = false;
  let accountingError: string | undefined;

  try {
    markDraftSent(deps);
    draftMarkedSent = true;
  } catch (e) {
    accountingError = appendAccountingError(accountingError, errorMessage(e));
  }

  try {
    writeAuditRow(deps, {
      ts: new Date().toISOString(),
      toolCallId: `runtime_${deps.draftId}_${t0}`,
      toolName: TOOL_NAME,
      input: auditInput(deps),
      output: {
        published: true,
        fallbackAllowed: false,
        dispatchAttempted: true,
        durationMs: Date.now() - t0,
        draftMarkedSent,
        accountingError,
      },
      error: null,
      stepFinishReason: "tool-calls",
    });
  } catch (e) {
    accountingError = appendAccountingError(accountingError, `writeAuditRow: ${errorMessage(e)}`);
  }

  try {
    emitCommitWarning(deps.workflowDeps, {
      workflowId: deps.workflowId,
      stepId: deps.stepId,
      label: "Post",
      severity: accountingError ? "high" : "low",
      accountingError,
    });
  } catch (e) {
    accountingError = appendAccountingError(accountingError, `emitCommitWarning: ${errorMessage(e)}`);
  }

  return { published: true, fallbackAllowed: false, dispatchAttempted: true, draftMarkedSent, accountingError };
}

function finishPreDispatchFailure(
  deps: PublishPostDeps,
  t0: number,
  reason: PublishFailReason,
  extraInput?: Record<string, unknown>,
): PublishResult {
  const fallbackAllowed = reason !== "approval_required" && reason !== "draft_already_sent";
  let accountingError: string | undefined;
  try {
    writeAuditRow(deps, {
      ts: new Date().toISOString(),
      toolCallId: `runtime_${deps.draftId}_${t0}`,
      toolName: TOOL_NAME,
      input: { ...auditInput(deps), ...extraInput },
      output: {
        published: false,
        reason,
        fallbackAllowed,
        dispatchAttempted: false,
        durationMs: Date.now() - t0,
      },
      error: null,
      stepFinishReason: "tool-calls",
    });
  } catch (e) {
    accountingError = appendAccountingError(accountingError, `writeAuditRow: ${errorMessage(e)}`);
  }
  return { published: false, reason, fallbackAllowed, dispatchAttempted: false, accountingError };
}

function finishPostDispatchAmbiguous(
  deps: PublishPostDeps,
  t0: number,
  reason: PublishFailReason,
  detail?: string,
): PublishResult {
  let draftMarkedSent = false;
  let accountingError = detail;

  try {
    markDraftSent(deps);
    draftMarkedSent = true;
  } catch (e) {
    accountingError = appendAccountingError(accountingError, `markDraftSent: ${errorMessage(e)}`);
  }

  try {
    writeAuditRow(deps, {
      ts: new Date().toISOString(),
      toolCallId: `runtime_${deps.draftId}_${t0}`,
      toolName: TOOL_NAME,
      input: auditInput(deps),
      output: {
        published: false,
        reason,
        fallbackAllowed: false,
        dispatchAttempted: true,
        durationMs: Date.now() - t0,
        draftMarkedSent,
        accountingError,
      },
      error: null,
      stepFinishReason: "tool-calls",
    });
  } catch (e) {
    accountingError = appendAccountingError(accountingError, `writeAuditRow: ${errorMessage(e)}`);
  }

  try {
    emitCommitWarning(deps.workflowDeps, {
      workflowId: deps.workflowId,
      stepId: deps.stepId,
      label: "Post",
      severity: "high",
      dispatchAmbiguous: true,
      accountingError,
    });
  } catch (e) {
    accountingError = appendAccountingError(accountingError, `emitCommitWarning: ${errorMessage(e)}`);
  }

  return {
    published: false,
    reason,
    fallbackAllowed: false,
    dispatchAttempted: true,
    draftMarkedSent,
    accountingError,
  };
}

function markDraftSent(deps: PublishPostDeps): void {
  const mark = deps.markDraftSent ?? markDraftSentDefault;
  mark(getSalesDb(deps.salesDbPath), deps.draftId);
}

function writeAuditRow(deps: PublishPostDeps, row: AuditEntry): void {
  const write = deps.writeAuditRow ?? appendAuditRow;
  write(deps.auditPath, row);
}

function auditInput(deps: PublishPostDeps): Record<string, unknown> {
  return {
    draftId: deps.draftId,
    source: SOURCE,
    workflowId: deps.workflowId,
    stepId: deps.stepId,
  };
}

function appendAccountingError(current: string | undefined, next: string): string {
  return current ? `${current}; ${next}` : next;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
