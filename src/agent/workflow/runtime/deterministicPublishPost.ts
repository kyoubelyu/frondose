import type { Database as DB } from "better-sqlite3";
import type { CdpClient } from "../../../cdp/client.js";
import {
  clearFeedComposerEditorLive,
  closeFeedComposerLive,
  composerTextMatches,
  FEED_COMPOSER_LIVE_IN_DOM_JS,
  focusFeedComposerEditorLive,
  isFeedComposerPostButtonEnabled,
  READBACK_RETRY_MS,
} from "../../../linkedin/composerReadiness.js";
import { resolveByLabelWithRetry } from "../../../linkedin/labelResolver.js";
import { captureCurrentSurfaceContext } from "../../../linkedin/snapshotCapture.js";
import type { CurrentSurfaceContext, LinkedinSession } from "../../../linkedin/types.js";
import { type AuditEntry, writeAuditRow as appendAuditRow } from "../../../persistence/audit.js";
import { getDraft, markDraftSent as markDraftSentDefault } from "../../../persistence/sales/drafts.js";
import { computeCharDelay } from "../../../tools/browser/type.js";
import { getSalesDb } from "../../../tools/sales/_dbHandle.js";
import type { WorkflowControllerDeps } from "../controller.js";
import { emitCommitWarning } from "./commitWarning.js";

const SOURCE = "approval_resume";
const TOOL_NAME = "post_publish_runtime";
const FEED_URL = "https://www.linkedin.com/feed/";
const COMPOSER_CLOSE_RETRY_ATTEMPTS = 3;
const COMPOSER_OPEN_RETRY_ROUNDS = 4;
const OPEN_IN_ROUND_PROBE_ATTEMPTS = 3;
const ENABLE_GATE_ATTEMPTS = 6;
const SURFACE_DIAGNOSTIC_JS = `(() => {
  const startBtn = (() => {
    const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
    const re = /^(start|create)\\s+a\\s+post\\b/i;
    const all = document.querySelectorAll('button,[role="button"]');
    for (const el of all) {
      const label = norm(el.getAttribute("aria-label") || el.innerText);
      if (re.test(label)) {
        const r = el.getBoundingClientRect();
        return { found: true, w: r.width, h: r.height };
      }
    }
    return { found: false, w: 0, h: 0 };
  })();
  return JSON.stringify({
    url: location.href,
    startBtnFound: startBtn.found,
    startBtnRectWH: [startBtn.w, startBtn.h],
    readyState: document.readyState,
    shareBoxNodeCount: document.querySelectorAll('[class*="share-box"],[class*="share-creation"]').length,
  });
})()`;

type SurfaceDiagnosticPhase = "preNavigate" | "postNavigate";
type CloseOutcome = "ok" | "failed_but_navigated" | "failed_then_aborted";
type OpenProbeOutcome = "present" | "absent";

interface SurfaceDiagnostic {
  phase: SurfaceDiagnosticPhase;
  url: string;
  startBtnFound: boolean;
  startBtnRectWH: [number, number];
  composerPresent: boolean;
  readyState: "loading" | "interactive" | "complete";
  shareBoxNodeCount: number;
  closeAttempted: boolean;
  closeOutcome: CloseOutcome | null;
  error?: string;
}

interface ComposerLiveProbeResult {
  present: boolean;
  editorText: string;
}

interface OpenResult {
  opened: boolean;
  openedOnRound: number | null;
  totalRounds: number;
  lastClickedRef: string | null;
  lastProbeOutcome: OpenProbeOutcome;
  everClicked: boolean;
  probeAtOpen: ComposerLiveProbeResult | null;
}

interface OpenStageDiagnostic {
  phase: "postOpen";
  opened: boolean;
  openedOnRound: number | null;
  totalRounds: number;
  lastClickedRef: string | null;
  lastProbeOutcome: OpenProbeOutcome;
}

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
  | "composer_close_failed"
  | "composer_open_click_failed"
  | "composer_absent_after_open"
  | "surface_not_composer_capable"
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
  enableGateAttempts?: number;
  draftMarkedSent?: boolean;
  accountingError?: string;
}

async function captureSurfaceDiagnostic(
  client: CdpClient,
  phase: SurfaceDiagnosticPhase,
  composerPresent: boolean,
  closeOutcome: CloseOutcome | null,
  error?: string,
): Promise<SurfaceDiagnostic> {
  const closeAttempted = phase === "preNavigate";
  const phaseCloseOutcome = phase === "preNavigate" ? closeOutcome : null;
  try {
    const raw = await client.evaluate<string>(SURFACE_DIAGNOSTIC_JS);
    const parsed = JSON.parse(raw) as Partial<Omit<SurfaceDiagnostic, "phase" | "composerPresent">>;
    const readyState =
      parsed.readyState === "loading" || parsed.readyState === "interactive" || parsed.readyState === "complete"
        ? parsed.readyState
        : "complete";
    const rect = Array.isArray(parsed.startBtnRectWH) ? parsed.startBtnRectWH : [0, 0];
    return {
      phase,
      url: typeof parsed.url === "string" ? parsed.url : "",
      startBtnFound: parsed.startBtnFound === true,
      startBtnRectWH: [Number(rect[0] ?? 0), Number(rect[1] ?? 0)],
      composerPresent,
      readyState,
      shareBoxNodeCount: typeof parsed.shareBoxNodeCount === "number" ? parsed.shareBoxNodeCount : 0,
      closeAttempted,
      closeOutcome: phaseCloseOutcome,
      ...(error ? { error } : {}),
    };
  } catch (e) {
    return {
      phase,
      url: "",
      startBtnFound: false,
      startBtnRectWH: [0, 0],
      composerPresent,
      readyState: "complete",
      shareBoxNodeCount: 0,
      closeAttempted,
      closeOutcome: phaseCloseOutcome,
      error: error ? `${error}; diagnostic: ${errorMessage(e)}` : errorMessage(e),
    };
  }
}

function emitSurfaceDiagnostic(deps: PublishPostDeps, t0: number, diag: SurfaceDiagnostic): void {
  try {
    writeAuditRow(deps, {
      ts: new Date().toISOString(),
      toolCallId: `runtime_diag_${deps.draftId}_${t0}_${diag.phase}`,
      toolName: "post_publish_runtime_diag",
      input: { ...auditInput(deps), phase: diag.phase },
      output: diag,
      error: diag.error ?? null,
      stepFinishReason: "tool-calls",
    });
  } catch {
    // best-effort; diagnostics must never block the deterministic publish path
  }
}

function emitOpenDiagnostic(deps: PublishPostDeps, t0: number, result: OpenResult): void {
  const output: OpenStageDiagnostic = {
    phase: "postOpen",
    opened: result.opened,
    openedOnRound: result.openedOnRound,
    totalRounds: result.totalRounds,
    lastClickedRef: result.lastClickedRef,
    lastProbeOutcome: result.lastProbeOutcome,
  };
  try {
    writeAuditRow(deps, {
      ts: new Date().toISOString(),
      toolCallId: `runtime_diag_${deps.draftId}_${t0}_postOpen`,
      toolName: "post_publish_runtime_diag",
      input: { ...auditInput(deps), phase: "postOpen" },
      output,
      error: null,
      stepFinishReason: "tool-calls",
    });
  } catch {
    // best-effort; diagnostics must never block the deterministic publish path
  }
}

function freshResolverSession(session: LinkedinSession): {
  getLastContext: () => undefined;
  setLastContext: (ctx: CurrentSurfaceContext) => void;
} {
  return {
    getLastContext: () => undefined,
    setLastContext: (ctx) => session.setLastContext(ctx),
  };
}

async function closeUnconditionally(client: CdpClient): Promise<CloseOutcome> {
  let closed = false;
  for (let attempt = 0; attempt < COMPOSER_CLOSE_RETRY_ATTEMPTS; attempt++) {
    closed = await closeFeedComposerLive(client);
    if (closed) break;
    if (attempt < COMPOSER_CLOSE_RETRY_ATTEMPTS - 1) await sleep(READBACK_RETRY_MS);
  }
  return closed ? "ok" : "failed_but_navigated";
}

async function hardenedOpenStartAPost(deps: PublishPostDeps): Promise<OpenResult> {
  let everClicked = false;
  let lastClickedRef: string | null = null;

  for (let round = 0; round < COMPOSER_OPEN_RETRY_ROUNDS; round++) {
    let clickedThisRound = false;
    try {
      const entry = await resolveByLabelWithRetry(
        freshResolverSession(deps.session),
        "Start a post",
        undefined,
        async () => {
          const next = await captureCurrentSurfaceContext(deps.client);
          deps.session.setLastContext(next);
          return next;
        },
        { timeoutMs: 3000, stepMs: 300 },
      );
      await deps.client.clickAt(entry.ref);
      clickedThisRound = true;
      everClicked = true;
      lastClickedRef = entry.ref;
    } catch {
      clickedThisRound = false;
    }

    if (clickedThisRound) {
      for (let attempt = 0; attempt < OPEN_IN_ROUND_PROBE_ATTEMPTS; attempt++) {
        await sleep(READBACK_RETRY_MS * (attempt + 1));
        const probe = await probeFeedComposerLive(deps.client);
        if (probe.present) {
          return {
            opened: true,
            openedOnRound: round + 1,
            totalRounds: COMPOSER_OPEN_RETRY_ROUNDS,
            lastClickedRef,
            lastProbeOutcome: "present",
            everClicked: true,
            probeAtOpen: probe,
          };
        }
      }
    }

    if (round < COMPOSER_OPEN_RETRY_ROUNDS - 1) {
      await sleep(READBACK_RETRY_MS * (1 << round));
    }
  }

  return {
    opened: false,
    openedOnRound: null,
    totalRounds: COMPOSER_OPEN_RETRY_ROUNDS,
    lastClickedRef,
    lastProbeOutcome: "absent",
    everClicked,
    probeAtOpen: null,
  };
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

    const closeOutcome = await closeUnconditionally(deps.client);

    const probe0 = await probeFeedComposerLive(deps.client);
    emitSurfaceDiagnostic(
      deps,
      t0,
      await captureSurfaceDiagnostic(deps.client, "preNavigate", probe0.present, closeOutcome),
    );

    try {
      await deps.client.navigate(FEED_URL);
      await sleep(READBACK_RETRY_MS);
    } catch (e) {
      const navigateError = errorMessage(e);
      emitSurfaceDiagnostic(
        deps,
        t0,
        await captureSurfaceDiagnostic(deps.client, "postNavigate", false, closeOutcome, navigateError),
      );
      return finishPreDispatchFailure(deps, t0, "surface_not_composer_capable", { navigateError });
    }

    const probe1 = await probeFeedComposerLive(deps.client);
    emitSurfaceDiagnostic(
      deps,
      t0,
      await captureSurfaceDiagnostic(deps.client, "postNavigate", probe1.present, closeOutcome),
    );

    const openResult = await hardenedOpenStartAPost(deps);
    emitOpenDiagnostic(deps, t0, openResult);
    if (!openResult.opened) {
      return finishPreDispatchFailure(
        deps,
        t0,
        openResult.everClicked ? "composer_absent_after_open" : "composer_open_click_failed",
      );
    }

    const probeOpen = openResult.probeAtOpen;
    if (!probeOpen) return finishPreDispatchFailure(deps, t0, "composer_absent_after_open");

    const focused = await focusFeedComposerEditorLive(deps.client);
    if (!focused) return finishPreDispatchFailure(deps, t0, "focus_failed");

    if (probeOpen.editorText.trim() !== "") {
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

    let enabled = false;
    let enableGateAttempts = 0;
    for (let i = 0; i < ENABLE_GATE_ATTEMPTS; i++) {
      enableGateAttempts = i + 1;
      enabled = await isFeedComposerPostButtonEnabled(deps.client);
      if (enabled) break;
      if (i < ENABLE_GATE_ATTEMPTS - 1) {
        // Progressive backoff: 120, 240, 480, 960, 1920 ms ≈ 3.7 s total.
        // Same shape as the hardened-open between-round backoff (§ hardenedOpenStartAPost).
        await sleep(READBACK_RETRY_MS * (1 << i));
      }
    }
    if (!enabled) {
      return finishPreDispatchFailure(deps, t0, "post_button_not_enabled", { enableGateAttempts });
    }

    let postEntry: CurrentSurfaceContext["entries"][number];
    try {
      postEntry = await resolveByLabelWithRetry(
        freshResolverSession(deps.session),
        "Post",
        undefined,
        async () => {
          const next = await captureCurrentSurfaceContext(deps.client);
          deps.session.setLastContext(next);
          return next;
        },
        { timeoutMs: 3000, stepMs: 300 },
      );
    } catch {
      return finishPreDispatchFailure(deps, t0, "post_coords_missing");
    }

    if (!postEntry.ref) {
      return finishPreDispatchFailure(deps, t0, "post_coords_missing", { unexpectedPostRef: "" });
    }

    dispatchAttempted = true;
    await deps.client.clickAt(postEntry.ref);

    await sleep(READBACK_RETRY_MS);
    let gone = !(await probeFeedComposerLive(deps.client)).present;
    if (!gone) {
      await sleep(READBACK_RETRY_MS);
      gone = !(await probeFeedComposerLive(deps.client)).present;
    }
    if (!gone) return finishPostDispatchAmbiguous(deps, t0, "composer_still_open");

    return finishSuccess(deps, t0, false, { enableGateAttempts });
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

async function probeFeedComposerLive(client: CdpClient): Promise<ComposerLiveProbeResult> {
  const raw = await client.evaluate<string>(FEED_COMPOSER_LIVE_IN_DOM_JS);
  const parsed = JSON.parse(raw) as { present?: boolean; editorText?: string };
  return parsed.present === true
    ? { present: true, editorText: typeof parsed.editorText === "string" ? parsed.editorText : "" }
    : { present: false, editorText: "" };
}

function finishSuccess(
  deps: PublishPostDeps,
  t0: number,
  fastPath = false,
  extra?: Record<string, unknown>,
): PublishResult {
  let draftMarkedSent = false;
  let accountingError: string | undefined;
  const enableGateAttempts = extra?.enableGateAttempts;

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
      input: { ...auditInput(deps), fastPath },
      output: {
        published: true,
        fallbackAllowed: false,
        dispatchAttempted: true,
        durationMs: Date.now() - t0,
        draftMarkedSent,
        accountingError,
        ...(extra ?? {}),
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

  const result: PublishResult = {
    published: true,
    fallbackAllowed: false,
    dispatchAttempted: true,
    draftMarkedSent,
    accountingError,
  };
  if (typeof enableGateAttempts === "number") {
    result.enableGateAttempts = enableGateAttempts;
  }
  return result;
}

function finishPreDispatchFailure(
  deps: PublishPostDeps,
  t0: number,
  reason: PublishFailReason,
  extraInput?: Record<string, unknown>,
): PublishResult {
  const fallbackAllowed = reason !== "approval_required" && reason !== "draft_already_sent";
  let accountingError: string | undefined;
  const enableGateAttempts = extraInput?.enableGateAttempts;
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
  const result: PublishResult = {
    published: false,
    reason,
    fallbackAllowed,
    dispatchAttempted: false,
    accountingError,
  };
  if (typeof enableGateAttempts === "number") {
    result.enableGateAttempts = enableGateAttempts;
  }
  return result;
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
