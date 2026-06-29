/**
 * Shared fakes and loaders for the native-port-S2-HARDEN publish action tests.
 */

import { resolve } from "node:path";

import type { CurrentSurfaceContext } from "../../../src/linkedin/logic/surface/currentSurfaceTypes.js";
import { getSalesDb } from "../../../src/tools/sales/_dbHandle.js";

// Disable inter-tool pacing for the mock suite.
process.env.FRONDOSE_PACE_MIN_MS = "0";

// Root path for source-grep tests (T-NoDoublePost-Harden.1).
export const ROOT = resolve(import.meta.dirname, "../../..");

// ---------------------------------------------------------------------------
// Dynamic loaders
// ---------------------------------------------------------------------------

const READINESS_SPEC = new URL("../../../src/linkedin/action/readiness.js", import.meta.url).href;

const PUBLISH_SPEC = new URL("../../../src/linkedin/action/publishPost.js", import.meta.url).href;

export interface OpenComposerResult {
  opened: boolean;
  openedOnRound: number;
  everClicked: boolean;
  contextAtOpen?: CurrentSurfaceContext;
}

export type OpenComposerHardenedFn = (deps: {
  client: unknown;
  capture: () => Promise<CurrentSurfaceContext>;
}) => Promise<OpenComposerResult>;

export type WaitForPostButtonEnabledFn = (client: unknown) => Promise<{ enabled: boolean; attempts: number }>;

export type ConfirmComposerGoneFn = (client: unknown) => Promise<{ gone: boolean; attempts: number }>;

export async function loadReadiness(): Promise<{
  openComposerHardened: OpenComposerHardenedFn;
  waitForPostButtonEnabled: WaitForPostButtonEnabledFn;
  confirmComposerGone: ConfirmComposerGoneFn;
}> {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic module access
  const mod = (await import(READINESS_SPEC)) as Record<string, any>;
  return {
    openComposerHardened: mod.openComposerHardened as OpenComposerHardenedFn,
    waitForPostButtonEnabled: mod.waitForPostButtonEnabled as WaitForPostButtonEnabledFn,
    confirmComposerGone: mod.confirmComposerGone as ConfirmComposerGoneFn,
  };
}

export interface HardenedPublishResult {
  published: boolean;
  dispatchAttempted: boolean;
  fallbackAllowed: boolean;
  reason?: string;
  durationMs?: number;
  draftMarkedSent?: boolean;
  advice?: unknown[];
  openRound?: number;
  enableGateAttempts?: number;
  composerGoneAttempts?: number;
}

export type PublishFn = (deps: Record<string, unknown>) => Promise<HardenedPublishResult>;

export async function loadPublish(): Promise<{ publishApprovedFeedPostViaAction: PublishFn }> {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic module access
  const mod = (await import(PUBLISH_SPEC)) as Record<string, any>;
  return {
    publishApprovedFeedPostViaAction: mod.publishApprovedFeedPostViaAction as PublishFn,
  };
}

// ---------------------------------------------------------------------------
// Fake surface-context factories
// ---------------------------------------------------------------------------

export function makePageContext(): CurrentSurfaceContext {
  return {
    pageUrl: "https://www.linkedin.com/feed/",
    surface: "feed",
    activeLayer: "page",
    entries: [{ ref: "@e1", role: "button", name: "Start a post" }],
    repeatedControls: [],
    summary: {
      surface: "feed",
      activeLayer: "page",
      availableScopes: [{ id: "feed", label: "Feed" }],
      text: [],
      buttons: ["Start a post"],
      inputs: [],
      interactiveRegions: [],
      ambiguityCases: [],
    },
  };
}

/** Page context with NO entries — resolveScopedTarget throws (button not found). */
export function makeEmptyPageContext(): CurrentSurfaceContext {
  return {
    pageUrl: "https://www.linkedin.com/feed/",
    surface: "feed",
    activeLayer: "page",
    entries: [],
    repeatedControls: [],
    summary: {
      surface: "feed",
      activeLayer: "page",
      availableScopes: [{ id: "feed", label: "Feed" }],
      text: [],
      buttons: [],
      inputs: [],
      interactiveRegions: [],
      ambiguityCases: [],
    },
  };
}

export function makeModalContext(withComposerInput = true): CurrentSurfaceContext {
  const inputs = withComposerInput ? ["Text editor for creating content"] : [];
  return {
    pageUrl: "https://www.linkedin.com/feed/",
    surface: "composer-modal",
    activeLayer: "modal",
    entries: [
      ...(withComposerInput ? [{ ref: "@e1", role: "textbox", name: "Text editor for creating content" }] : []),
      { ref: "@e2", role: "button", name: "Post" },
    ],
    repeatedControls: [],
    summary: {
      surface: "composer-modal",
      activeLayer: "modal",
      availableScopes: [
        ...(withComposerInput
          ? [
              { id: "composerModal" as const, label: "Composer modal" },
              { id: "composerInput" as const, label: "Composer input" },
            ]
          : [{ id: "composerModal" as const, label: "Composer modal" }]),
      ],
      text: [],
      buttons: ["Post"],
      inputs,
      interactiveRegions: [],
      ambiguityCases: [],
    },
  };
}

/**
 * Modal context that has composerInput but NOT composerModal in availableScopes.
 * Used by T-ScopeBudget.4 to simulate AX-snapshot race at the step-8 Post resolve:
 * the composerModal scope intermittently disappears so scopeIsAvailable("composerModal")
 * returns false, forcing the 8×400ms budget to retry.
 */
export function makeModalContextNoComposerModal(): CurrentSurfaceContext {
  return {
    pageUrl: "https://www.linkedin.com/feed/",
    surface: "composer-modal",
    activeLayer: "modal",
    entries: [
      { ref: "@e1", role: "textbox", name: "Text editor for creating content" },
      { ref: "@e2", role: "button", name: "Post" },
    ],
    repeatedControls: [],
    summary: {
      surface: "composer-modal",
      activeLayer: "modal",
      availableScopes: [
        // composerInput present but composerModal intentionally absent
        { id: "composerInput" as const, label: "Composer input" },
      ],
      text: [],
      buttons: ["Post"],
      inputs: ["Text editor for creating content"],
      interactiveRegions: [],
      ambiguityCases: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Fake CdpClient for harden tests
// ---------------------------------------------------------------------------

export interface HardenedFakeClientOpts {
  urlQueue: string[];
  navigateLog: string[];
  evaluateQueues: Map<string, unknown[]>;
  clickAtLog: string[];
  raceHandleLog: Array<{ label: string; text?: string }>;
  navigateShouldThrow?: boolean;
  clickAtAlwaysThrow?: boolean;
  clickAtThrowOnCall?: number;
  clickAtThrowError?: Error;
}

function peekOrLast<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr.length === 1 ? arr[0] : arr.shift();
}

function dequeueOrLast<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  if (arr.length === 1) return arr[0];
  return arr.shift();
}

class EvalThrowSentinel {
  constructor(readonly message: string = "simulated transient evaluate error") {}
}

export function evalThrow(msg?: string): EvalThrowSentinel {
  return new EvalThrowSentinel(msg);
}

export function makeFakeHardenedClient(opts: HardenedFakeClientOpts): unknown {
  let clickAtCallCount = 0;
  return {
    getCurrentUrl: async () => peekOrLast(opts.urlQueue) ?? "https://www.linkedin.com/feed/",
    navigate: async (url: string) => {
      opts.navigateLog.push(url);
      if (opts.navigateShouldThrow) {
        throw new Error("auth: checkpoint - simulated auth interruption");
      }
    },
    evaluate: async <T>(expression: string): Promise<T> => {
      for (const [key, queue] of opts.evaluateQueues) {
        if (expression.includes(key)) {
          const val = dequeueOrLast(queue);
          if (val instanceof EvalThrowSentinel) {
            throw new Error(val.message);
          }
          return val as T;
        }
      }
      return undefined as unknown as T;
    },
    snapshot: async () => ({ entries: [], refMap: new Map() }),
    clickAt: async (selector: string) => {
      clickAtCallCount++;
      opts.clickAtLog.push(selector);
      if (opts.clickAtAlwaysThrow) {
        throw new Error("simulated clickAt failure (all rounds)");
      }
      if (
        opts.clickAtThrowOnCall !== undefined &&
        clickAtCallCount >= opts.clickAtThrowOnCall &&
        opts.clickAtThrowError
      ) {
        throw opts.clickAtThrowError;
      }
    },
    raceHandle: async <T>(p: Promise<T>, label: string): Promise<T> => {
      opts.raceHandleLog.push({ label });
      return p;
    },
    handle: {
      Input: {
        insertText: async (args: { text: string }) => {
          const last = opts.raceHandleLog[opts.raceHandleLog.length - 1];
          if (last) last.text = args.text;
          return {};
        },
        dispatchKeyEvent: async () => ({}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// DB seed + publish deps helpers
// ---------------------------------------------------------------------------

export function seedDraft(dbPath: string, draftId: string, text: string): void {
  const db = getSalesDb(dbPath);
  const existing = db.prepare("SELECT id FROM message_drafts WHERE id = ?").get(draftId);
  if (!existing) {
    db.prepare(
      `INSERT INTO message_drafts (id, lead_id, kind, text, status, created_by, evidence, created_at)
         VALUES (?, NULL, 'post', ?, 'draft', 'llm', NULL, ?)`,
    ).run(draftId, text, Date.now());
  }
}

export interface AuditRow {
  ts?: string;
  toolCallId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export function makeHardenedPublishDeps(opts: {
  client: unknown;
  salesDbPath: string;
  auditPath: string;
  draftId: string;
  auditRowLog: AuditRow[];
  captureQueue: CurrentSurfaceContext[];
}): Record<string, unknown> {
  let captureIdx = 0;
  return {
    session: { resolvedMode: () => "manual", inputMode: "cdp" },
    client: opts.client,
    salesDbPath: opts.salesDbPath,
    auditPath: opts.auditPath,
    workflowDeps: {
      emitFrame: async () => {},
      writeWorkflowAudit: async () => {},
    },
    workflowId: "wf-harden-001",
    stepId: "step-harden-001",
    draftId: opts.draftId,
    writeAuditRow: (_path: string, row: AuditRow) => {
      opts.auditRowLog.push(row);
    },
    captureCurrentSurfaceContext: async () => {
      const ctx = opts.captureQueue[captureIdx];
      if (captureIdx < opts.captureQueue.length - 1) captureIdx++;
      return ctx ?? makePageContext();
    },
  };
}

// ---------------------------------------------------------------------------
// setTimeout spy — runs callbacks immediately, records original ms values
// ---------------------------------------------------------------------------

export type OriginalSetTimeout = typeof setTimeout;

export function installSleepSpy(): { sleepLog: number[]; restore: () => void } {
  // biome-ignore lint/suspicious/noExplicitAny: spy override
  const orig: OriginalSetTimeout = (globalThis as any).setTimeout;
  const sleepLog: number[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: spy override
  (globalThis as any).setTimeout = (cb: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    sleepLog.push(ms ?? 0);
    // biome-ignore lint/suspicious/noExplicitAny: run at 0ms for speed
    return orig(cb as any, 0, ...rest);
  };
  return {
    sleepLog,
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restore original
      (globalThis as any).setTimeout = orig;
    },
  };
}

// ---------------------------------------------------------------------------
// Happy-path evaluate queues
// ---------------------------------------------------------------------------

export function makeHappyHardenedEvalQueues(draftText: string): Map<string, unknown[]> {
  return new Map([
    ["activeElement", [true]],
    ["execCommand", [true]],
    ["editorText", [JSON.stringify({ present: true, editorText: draftText })]],
    ["aria-disabled", [true]],
    ["JSON.stringify({pres", [JSON.stringify({ present: false })]],
  ]);
}
