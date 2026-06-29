/**
 * Phase native-port-S2 — Step 5 (validator, Sonnet) — assertions filled
 * §5.C: publishApprovedFeedPostViaAction orchestration tests.
 *
 * Source-under-test: src/linkedin/action/publishPost.ts
 *
 * Harness modeled on P12FakeClientOpts from
 * tests/agent/workflow/runtime/deterministicPublishPost-resolve.mock.test.ts.
 * Key seams:
 *   - Fake CdpClient: scriptable getCurrentUrl, navigate, evaluate (payload-keyed),
 *     snapshot, clickAt (counted), raceHandle (counted for insertText).
 *   - Fake captureCurrentSurfaceContext: returns a queue of CurrentSurfaceContext fixtures.
 *   - Real getSalesDb / seedDraft for markDraftSent testing.
 *   - Fake writeAuditRow collecting rows.
 *
 * NIT-R2-2: the stale "PLAN DISCREPANCY" comment block at the original lines 23-28 has
 * been replaced with the verified Step-5 comment (see §6.2 + critics doc).
 * The active T-Advice.1 contract (phase:'commit', kind:'remember_recommended') is correct.
 *
 * Gates covered: §5.C T-Happy.1–2, T-NoDoublePost.1–2, T-Resolve.1–2, T-Readback.1,
 *                T-Advice.1, T-Settle.1, T-Pacing.1, T-AuthInterrupt.1.
 *
 * Runner:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/linkedin/action/publishPost.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import type { CurrentSurfaceContext } from "../../../src/linkedin/logic/surface/currentSurfaceTypes.js";
import { getSalesDb } from "../../../src/tools/sales/_dbHandle.js";

// Disable inter-tool pacing for the mock suite.
process.env.FRONDOSE_PACE_MIN_MS = "0";

// ---------------------------------------------------------------------------
// Root path for structural source-grep tests (T-NoDoublePost.1)
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, "../../..");

// ---------------------------------------------------------------------------
// Dynamic loader for publishPost.ts
// ---------------------------------------------------------------------------

const PUBLISH_SPEC = new URL("../../../src/linkedin/action/publishPost.js", import.meta.url).href;

interface PublishResult {
  published: boolean;
  dispatchAttempted: boolean;
  fallbackAllowed: boolean;
  reason?: string;
  durationMs?: number;
  draftMarkedSent?: boolean;
  advice?: unknown[];
}

type PublishFn = (deps: Record<string, unknown>) => Promise<PublishResult>;

async function loadPublish(): Promise<{ publishApprovedFeedPostViaAction: PublishFn }> {
  const mod = (await import(PUBLISH_SPEC)) as Record<string, unknown>;
  return {
    publishApprovedFeedPostViaAction: mod["publishApprovedFeedPostViaAction"] as PublishFn,
  };
}

// ---------------------------------------------------------------------------
// Captured audit row type
// ---------------------------------------------------------------------------

interface CapturedAuditRow {
  ts?: string;
  toolCallId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: unknown;
  stepFinishReason?: string;
}

// ---------------------------------------------------------------------------
// Minimal fake CurrentSurfaceContext factories
// ---------------------------------------------------------------------------

function makePageContext(): CurrentSurfaceContext {
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

function makeModalContext(withComposerInput = true): CurrentSurfaceContext {
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

// ---------------------------------------------------------------------------
// Fake CdpClient harness (action-layer variant)
// Payload-keyed evaluate dispatch mirrors P12FakeClientOpts pattern.
// ---------------------------------------------------------------------------

interface FakeActionClientOpts {
  /** Queue of getCurrentUrl responses (pop-or-last). */
  urlQueue: string[];
  /** Navigate log. */
  navigateLog: string[];
  /** Payload-keyed evaluate responses. Key is a substring present in the expression. */
  evaluateResponses: Map<string, unknown>;
  /** Log of all clickAt calls (selector/ref strings). */
  clickAtLog: string[];
  /** Log of all raceHandle calls: {label, text?}. */
  raceHandleLog: Array<{ label: string; text?: string }>;
  /** Whether navigate throws (for T-AuthInterrupt.1 etc.). */
  navigateShouldThrow?: boolean;
  /** If set, the Nth clickAt call (1-based) throws this error. */
  clickAtThrowOnCall?: number;
  /** Error to throw when clickAtThrowOnCall is reached. */
  clickAtThrowError?: Error;
}

function peekOrLast<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr.length === 1 ? arr[0] : arr.shift();
}

function makeFakeActionClient(opts: FakeActionClientOpts): unknown {
  let clickAtCallCount = 0;
  return {
    getCurrentUrl: async () => {
      return peekOrLast(opts.urlQueue) ?? "https://www.linkedin.com/feed/";
    },
    navigate: async (url: string) => {
      opts.navigateLog.push(url);
      if (opts.navigateShouldThrow) {
        throw new Error("auth: checkpoint - simulated auth interruption");
      }
    },
    evaluate: async <T>(expression: string): Promise<T> => {
      for (const [key, val] of opts.evaluateResponses) {
        if (expression.includes(key)) {
          return val as T;
        }
      }
      return undefined as unknown as T;
    },
    snapshot: async () => ({ entries: [], refMap: new Map() }),
    clickAt: async (selector: string) => {
      clickAtCallCount++;
      opts.clickAtLog.push(selector);
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
// Seed draft helper
// ---------------------------------------------------------------------------

function seedDraft(dbPath: string, draftId: string, text: string): void {
  const db = getSalesDb(dbPath);
  const existing = db.prepare("SELECT id FROM message_drafts WHERE id = ?").get(draftId);
  if (!existing) {
    db.prepare(
      `INSERT INTO message_drafts (id, lead_id, kind, text, status, created_by, evidence, created_at)
         VALUES (?, NULL, 'post', ?, 'draft', 'llm', NULL, ?)`,
    ).run(draftId, text, Date.now());
  }
}

// ---------------------------------------------------------------------------
// Make publish deps helper
// ---------------------------------------------------------------------------

function makePublishDeps(opts: {
  client: unknown;
  salesDbPath: string;
  auditPath: string;
  draftId: string;
  auditRowLog: CapturedAuditRow[];
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
    workflowId: "wf-test-001",
    stepId: "step-test-001",
    draftId: opts.draftId,
    writeAuditRow: (_path: string, row: CapturedAuditRow) => {
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
// setTimeout spy helper — runs callbacks at 0ms, records original ms values
// ---------------------------------------------------------------------------

type OriginalSetTimeout = typeof setTimeout;

function installSleepSpy(): { sleepLog: number[]; restore: () => void } {
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
// Shared evaluate responses for "happy path" (focus + clear + editor read-back)
// ---------------------------------------------------------------------------

function makeHappyEvalResponses(draftText: string): Map<string, unknown> {
  return new Map([
    // COMPOSER_FOCUS_JS discriminator key: "activeElement"
    ["activeElement", true],
    // COMPOSER_CLEAR_JS discriminator key: "execCommand"
    ["execCommand", true],
    // COMPOSER_EDITOR_JS discriminator key: "editorText"
    ["editorText", JSON.stringify({ present: true, editorText: draftText })],
  ]);
}

// ---------------------------------------------------------------------------
// §5.C T-Happy.1 — full clean drive → published:true, clickAt×2, markDraftSent×1
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPostViaAction — happy path (T-Happy.1)", () => {
  it(
    "T-Happy.1: given a clean drive (already-on-feed, composer not yet open, fresh draft 'P-S2 LIVE one'), " +
      "when publishApprovedFeedPostViaAction(deps) is awaited, " +
      "then result is {published:true,dispatchAttempted:true,fallbackAllowed:false}, clickAt is called exactly twice, dispatch click is the second, and markDraftSent called once",
    async () => {
      // Given: on feed; page layer (composer closed); valid draft in DB.
      // When: publishApprovedFeedPostViaAction runs the full 11-step flow.
      // Then: published:true; clickAt×2 (open + dispatch); markDraftSent×1.
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const scratchDir = join(tmpdir(), `frondose-s2-happy1-${Date.now()}`);
      mkdirSync(scratchDir, { recursive: true });

      const draftId = "draft-happy-1";
      const draftText = "P-S2 LIVE one";
      seedDraft(join(scratchDir, "sales.db"), draftId, draftText);

      const navigateLog: string[] = [];
      const clickAtLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];

      const client = makeFakeActionClient({
        urlQueue: ["https://www.linkedin.com/feed/"],
        navigateLog,
        evaluateResponses: makeHappyEvalResponses(draftText),
        clickAtLog,
        raceHandleLog,
      });

      const auditRowLog: CapturedAuditRow[] = [];
      // captureQueue:
      //   [0] page → open-composer branch fires (clickAtLog[0])
      //   [1] page → discarded post-click re-capture
      //   [2] modal → composerInput found (SCOPE_READY_ATTEMPTS attempt 0)
      //   [3] modal → Post button found (SCOPE_READY_ATTEMPTS attempt 0)
      const pageCtx = makePageContext();
      const modalCtx = makeModalContext();
      const deps = makePublishDeps({
        client,
        salesDbPath: join(scratchDir, "sales.db"),
        auditPath: join(scratchDir, "audit.jsonl"),
        draftId,
        auditRowLog,
        captureQueue: [pageCtx, pageCtx, modalCtx, modalCtx, modalCtx],
      });

      const { restore } = installSleepSpy();
      let result: PublishResult;
      try {
        result = await publishApprovedFeedPostViaAction(deps);
      } finally {
        restore();
      }

      assert.equal(result.published, true, "T-Happy.1: published must be true");
      assert.equal(result.dispatchAttempted, true, "T-Happy.1: dispatchAttempted must be true");
      assert.equal(result.fallbackAllowed, false, "T-Happy.1: fallbackAllowed must be false");

      // clickAt×2: [0] = "Start a post" open click, [1] = "Post" dispatch click
      assert.equal(clickAtLog.length, 2, "T-Happy.1: exactly 2 clickAt calls (open + dispatch)");

      // markDraftSent: draft status should be updated
      assert.equal(result.draftMarkedSent, true, "T-Happy.1: draftMarkedSent must be true");

      // At least one audit row written
      assert.ok(auditRowLog.length >= 1, "T-Happy.1: at least one audit row must be written");
    },
  );
});

// ---------------------------------------------------------------------------
// §5.C T-Happy.2 — already on feed + composer pre-opened → no navigate, clickAt×1
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPostViaAction — composer already open (T-Happy.2)", () => {
  it(
    "T-Happy.2: given already-on-feed AND composer pre-opened with correct text (fast-path), " +
      "when publishApprovedFeedPostViaAction runs, " +
      "then no navigate fires AND clickAt count is exactly 1 (only the Post dispatch)",
    async () => {
      // Given: page starts at modal layer (composer already open).
      // When: publishApprovedFeedPostViaAction runs.
      // Then: navigate×0; clickAt×1 (dispatch only).
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const scratchDir = join(tmpdir(), `frondose-s2-happy2-${Date.now()}`);
      mkdirSync(scratchDir, { recursive: true });

      const draftId = "draft-happy-2";
      const draftText = "P-S2 fast-path";
      seedDraft(join(scratchDir, "sales.db"), draftId, draftText);

      const navigateLog: string[] = [];
      const clickAtLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];

      const client = makeFakeActionClient({
        urlQueue: ["https://www.linkedin.com/feed/"],
        navigateLog,
        evaluateResponses: makeHappyEvalResponses(draftText),
        clickAtLog,
        raceHandleLog,
      });

      const auditRowLog: CapturedAuditRow[] = [];
      const modalCtx = makeModalContext();
      // captureQueue:
      //   [0] modal → initial, skip open-composer branch
      //   [1] modal → composerInput found (captureScopedContext attempt 0)
      //   [2] modal → Post button found (captureScopedContext attempt 0)
      const deps = makePublishDeps({
        client,
        salesDbPath: join(scratchDir, "sales.db"),
        auditPath: join(scratchDir, "audit.jsonl"),
        draftId,
        auditRowLog,
        captureQueue: [modalCtx, modalCtx, modalCtx],
      });

      const { restore } = installSleepSpy();
      let result: PublishResult;
      try {
        result = await publishApprovedFeedPostViaAction(deps);
      } finally {
        restore();
      }

      assert.equal(result.published, true, "T-Happy.2: published must be true");
      assert.equal(
        navigateLog.length,
        0,
        "T-Happy.2: navigate must NOT be called (already on feed with reusedSession)",
      );
      assert.equal(clickAtLog.length, 1, "T-Happy.2: exactly 1 clickAt (dispatch only, no open-composer click)");
    },
  );
});

// ---------------------------------------------------------------------------
// §5.C T-NoDoublePost.1 — post-dispatch throw → dispatchAttempted:true, fallbackAllowed:false, no second click
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPostViaAction — no-double-post: post-dispatch throw (T-NoDoublePost.1)", () => {
  it(
    "T-NoDoublePost.1: given the dispatch clickAt THROWS post-dispatch, " +
      "when the orchestration unwinds, " +
      "then result has dispatchAttempted:true AND fallbackAllowed:false, no second dispatch clickAt fires, " +
      "and a source-grep over publishPost.ts using anchored regex /^\\s*dispatchAttempted\\s*=\\s*true;\\s*$/m " +
      "finds exactly ONE matching line (anchored to ignore comment occurrences per CONCERN-MR-4), " +
      "and ONE clickAt( for the Post dispatch (region-anchored between verifyTypedTextOnSameTarget and epilogue)",
    async () => {
      // Given: the dispatch clickAt throws after the latch is set.
      // When: publishApprovedFeedPostViaAction unwinds on the throw.
      // Then: dispatchAttempted:true; fallbackAllowed:false; source invariant verified.
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const scratchDir = join(tmpdir(), `frondose-s2-nodouble1-${Date.now()}`);
      mkdirSync(scratchDir, { recursive: true });

      const draftId = "draft-no-double-1";
      const draftText = "no double post";
      seedDraft(join(scratchDir, "sales.db"), draftId, draftText);

      const clickAtLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];

      // Initial modal context → skip open-composer branch, so only ONE clickAt = dispatch
      // That dispatch clickAt will throw (clickAtThrowOnCall=1 since there's only 1 call).
      const client = makeFakeActionClient({
        urlQueue: ["https://www.linkedin.com/feed/"],
        navigateLog: [],
        evaluateResponses: makeHappyEvalResponses(draftText),
        clickAtLog,
        raceHandleLog,
        clickAtThrowOnCall: 1,
        clickAtThrowError: new Error("simulated post-dispatch throw"),
      });

      const auditRowLog: CapturedAuditRow[] = [];
      const modalCtx = makeModalContext();
      const deps = makePublishDeps({
        client,
        salesDbPath: join(scratchDir, "sales.db"),
        auditPath: join(scratchDir, "audit.jsonl"),
        draftId,
        auditRowLog,
        captureQueue: [modalCtx, modalCtx, modalCtx],
      });

      const { restore } = installSleepSpy();
      let result: PublishResult;
      try {
        result = await publishApprovedFeedPostViaAction(deps);
      } finally {
        restore();
      }

      // No-double-post invariant: dispatchAttempted:true means the latch was set
      // before the throw → system knows the click MAY have fired → no fallback.
      assert.equal(
        result.dispatchAttempted,
        true,
        "T-NoDoublePost.1: dispatchAttempted must be true (latch set before dispatch)",
      );
      assert.equal(
        result.fallbackAllowed,
        false,
        "T-NoDoublePost.1: fallbackAllowed must be false (post-dispatch ambiguous)",
      );

      // Exactly 1 clickAt attempted (the dispatch — which threw)
      assert.equal(clickAtLog.length, 1, "T-NoDoublePost.1: exactly 1 clickAt (the dispatch, even though it threw)");

      // Source-grep: anchored regex finds exactly ONE `dispatchAttempted = true;` assignment line.
      // Using line-anchored regex per CONCERN-MR-4 (ignores comments).
      const source = readFileSync(join(ROOT, "src/linkedin/action/publishPost.ts"), "utf-8");
      const latchLines = source.split("\n").filter((line) => /^\s*dispatchAttempted\s*=\s*true;\s*$/.test(line));
      assert.equal(
        latchLines.length,
        1,
        "T-NoDoublePost.1: source must have exactly ONE `dispatchAttempted = true;` assignment line (no duplicate latch)",
      );

      // Also verify there is exactly ONE `clickAt(` call in the publish block
      // (region between the latch and the finishers) — anchored by source structure.
      const clickAtLines = source
        .split("\n")
        .filter((line) => /^\s*await deps\.client\.clickAt\(/.test(line) && line.includes("postResolved"));
      assert.equal(
        clickAtLines.length,
        1,
        "T-NoDoublePost.1: source must have exactly ONE `await deps.client.clickAt(postResolved.target.selector)` dispatch line",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// §5.C T-NoDoublePost.2 — pre-dispatch failure → dispatchAttempted:false, fallbackAllowed:true, zero Post clicks
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPostViaAction — no-double-post: pre-dispatch failure (T-NoDoublePost.2)", () => {
  it(
    "T-NoDoublePost.2: given ensureInputReady throws (pre-dispatch failure), " +
      "when the orchestration returns, " +
      "then result has dispatchAttempted:false AND fallbackAllowed:true " +
      "AND zero clickAt invocations on the Post resolver",
    async () => {
      // Given: ensureInputReady throws before any dispatch click.
      // When: publishApprovedFeedPostViaAction returns.
      // Then: dispatchAttempted:false; fallbackAllowed:true; Post clickAt count=0.
      //
      // Mechanism: initial capture returns modalCtx (skip open-composer),
      // then composerInput resolve returns a PAGE-layer context (activeLayer="page")
      // with composerInput in availableScopes. ensureInputReady checks activeLayer!=="modal"
      // and throws CommandNotFoundError → finishPreDispatch("input_layer_mismatch").
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const scratchDir = join(tmpdir(), `frondose-s2-nodouble2-${Date.now()}`);
      mkdirSync(scratchDir, { recursive: true });

      const draftId = "draft-no-double-2";
      const draftText = "no double pre-dispatch";
      seedDraft(join(scratchDir, "sales.db"), draftId, draftText);

      const clickAtLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];

      const client = makeFakeActionClient({
        urlQueue: ["https://www.linkedin.com/feed/"],
        navigateLog: [],
        evaluateResponses: makeHappyEvalResponses(draftText),
        clickAtLog,
        raceHandleLog,
      });

      const auditRowLog: CapturedAuditRow[] = [];

      // modalCtx as initial (skip open-composer click — so zero open clicks)
      const modalCtx = makeModalContext();

      // pageLayerWithComposerInput: page layer context but composerInput in availableScopes.
      // The resolver finds it (isComposerInputEntry matches the textbox name), then
      // ensureInputReady(pageLayerCtx, target) throws because activeLayer !== "modal".
      const pageLayerWithComposerInputCtx: CurrentSurfaceContext = {
        pageUrl: "https://www.linkedin.com/feed/",
        surface: "composer-modal",
        activeLayer: "page",
        entries: [{ ref: "@e1", role: "textbox", name: "Text editor for creating content" }],
        repeatedControls: [],
        summary: {
          surface: "composer-modal",
          activeLayer: "page",
          availableScopes: [{ id: "composerInput" as const, label: "Composer input" }],
          text: [],
          buttons: [],
          inputs: ["Text editor for creating content"],
          interactiveRegions: [],
          ambiguityCases: [],
        },
      };

      // captureQueue:
      //   [0] modal → initial, skip open-composer branch (no open click)
      //   [1] pageLayerWithComposerInput → captureScopedContext attempt 0 for composerInput
      //       The resolver finds the textbox via isComposerInputEntry → returns target
      //       ensureInputReady(pageLayerCtx) → throws (activeLayer !== "modal")
      const deps = makePublishDeps({
        client,
        salesDbPath: join(scratchDir, "sales.db"),
        auditPath: join(scratchDir, "audit.jsonl"),
        draftId,
        auditRowLog,
        captureQueue: [modalCtx, pageLayerWithComposerInputCtx],
      });

      const { restore } = installSleepSpy();
      let result: PublishResult;
      try {
        result = await publishApprovedFeedPostViaAction(deps);
      } finally {
        restore();
      }

      assert.equal(
        result.dispatchAttempted,
        false,
        "T-NoDoublePost.2: dispatchAttempted must be false (pre-dispatch failure)",
      );
      assert.equal(
        result.fallbackAllowed,
        true,
        "T-NoDoublePost.2: fallbackAllowed must be true (pre-dispatch; LLM can retry)",
      );

      // Zero Post dispatch clicks (the failure happened before the dispatch)
      // The open-composer branch was skipped (initial context was modal), so clickAtLog is empty.
      assert.equal(
        clickAtLog.length,
        0,
        "T-NoDoublePost.2: zero clickAt calls (failed before open-composer or dispatch)",
      );
      assert.equal(result.reason, "input_layer_mismatch", "T-NoDoublePost.2: reason must be 'input_layer_mismatch'");
    },
  );
});

// ---------------------------------------------------------------------------
// §5.C T-Resolve.1 — scope-ready retry: resolves on 3rd attempt, 2× 250ms sleeps
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPostViaAction — scope-ready retry budget (T-Resolve.1)", () => {
  it(
    "T-Resolve.1: given resolveScopedTarget resolves on the 3rd attempt (2× 250ms sleeps), " +
      "when the action runs, " +
      "then publish completes successfully AND the captured setTimeout budget is exactly [250,250]",
    async () => {
      // Given: captureScopedContext retries; composerInput found on attempt 3.
      // When: publishApprovedFeedPostViaAction runs.
      // Then: published:true; two 250ms setTimeout calls observed (globalThis.setTimeout spy).
      //
      // captureQueue for composerInput retry:
      //   [0] page → initial, open-composer click fires (clickAt[0])
      //   [1] page → discarded post-click re-capture
      //   [2] page → captureScopedContext attempt 0 (composerInput NOT found)
      //     sleep(250ms)
      //   [3] page → captureScopedContext attempt 1 (composerInput NOT found)
      //     sleep(250ms)
      //   [4] modal → captureScopedContext attempt 2 (composerInput FOUND!)
      //   [5] modal → Post button captureScopedContext attempt 0 (FOUND!)
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const scratchDir = join(tmpdir(), `frondose-s2-resolve1-${Date.now()}`);
      mkdirSync(scratchDir, { recursive: true });

      const draftId = "draft-resolve-1";
      const draftText = "retry-test text";
      seedDraft(join(scratchDir, "sales.db"), draftId, draftText);

      const clickAtLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];

      const client = makeFakeActionClient({
        urlQueue: ["https://www.linkedin.com/feed/"],
        navigateLog: [],
        evaluateResponses: makeHappyEvalResponses(draftText),
        clickAtLog,
        raceHandleLog,
      });

      const auditRowLog: CapturedAuditRow[] = [];
      const pageCtx = makePageContext();
      const modalCtx = makeModalContext();

      const deps = makePublishDeps({
        client,
        salesDbPath: join(scratchDir, "sales.db"),
        auditPath: join(scratchDir, "audit.jsonl"),
        draftId,
        auditRowLog,
        captureQueue: [
          pageCtx, // [0] initial → page → open-composer click fires
          pageCtx, // [1] post-click re-capture (discarded)
          pageCtx, // [2] composerInput attempt 0 → fail
          pageCtx, // [3] composerInput attempt 1 → fail (sleep 250ms)
          modalCtx, // [4] composerInput attempt 2 → SUCCESS
          modalCtx, // [5] Post button attempt 0 → SUCCESS
          modalCtx, // extra buffer
        ],
      });

      const { sleepLog, restore } = installSleepSpy();
      let result: PublishResult;
      try {
        result = await publishApprovedFeedPostViaAction(deps);
      } finally {
        restore();
      }

      assert.equal(result.published, true, "T-Resolve.1: must publish successfully despite initial retries");
      assert.equal(result.dispatchAttempted, true, "T-Resolve.1: dispatchAttempted must be true");

      // Exactly 2 scope-ready retry sleeps of 250ms each
      const scopeRetrySleePs = sleepLog.filter((ms) => ms === 250);
      assert.equal(
        scopeRetrySleePs.length,
        2,
        `T-Resolve.1: exactly 2 scope-ready retry sleeps of 250ms (SCOPE_READY_RETRY_MS=250), got ${scopeRetrySleePs.length} in [${sleepLog.join(",")}]`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// §5.C T-Resolve.2 — all scope-ready retries exhaust → reason:composer_unavailable
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPostViaAction — pre-click resolve failure (T-Resolve.2)", () => {
  it(
    "T-Resolve.2: given resolveScopedTarget for the Post button THROWS CommandNotFoundError at step 8, " +
      "when the action runs, " +
      "then result has reason:'post_resolve_failed', dispatchAttempted:false, fallbackAllowed:true, " +
      "and clickAt was NEVER called on a Post-button selector",
    async () => {
      // Given: post-button re-resolve throws CommandNotFoundError (all scope retries exhausted,
      //        captureScopedContext returns a page context without composerModal).
      // When: publishApprovedFeedPostViaAction runs.
      // Then: reason:post_resolve_failed; dispatch never fires.
      //
      // We exhaust ALL retries for the Post button resolve by providing a page context
      // for all captures after the fill step.
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const scratchDir = join(tmpdir(), `frondose-s2-resolve2-${Date.now()}`);
      mkdirSync(scratchDir, { recursive: true });

      const draftId = "draft-resolve-2";
      const draftText = "resolve fail text";
      seedDraft(join(scratchDir, "sales.db"), draftId, draftText);

      const clickAtLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];

      const client = makeFakeActionClient({
        urlQueue: ["https://www.linkedin.com/feed/"],
        navigateLog: [],
        evaluateResponses: makeHappyEvalResponses(draftText),
        clickAtLog,
        raceHandleLog,
      });

      const auditRowLog: CapturedAuditRow[] = [];
      // Initial modal → skip open-composer click
      // composerInput resolve: modal at attempt 0 → immediate success
      // After fill + verify, Post button resolve: page contexts only → all 5 attempts fail
      const modalCtx = makeModalContext();
      const pageCtxNoModal: CurrentSurfaceContext = {
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

      // captureQueue:
      //   [0] modal → initial, skip open-composer
      //   [1] modal → composerInput attempt 0 → immediate success
      //   [2..6] pageCtxNoModal → Post button attempts 0..4 → all fail
      //   ensureScopeAvailable(page, "composerModal") throws CommandNotFoundError
      const deps = makePublishDeps({
        client,
        salesDbPath: join(scratchDir, "sales.db"),
        auditPath: join(scratchDir, "audit.jsonl"),
        draftId,
        auditRowLog,
        captureQueue: [
          modalCtx, // [0] initial
          modalCtx, // [1] composerInput immediate success
          pageCtxNoModal, // [2] Post attempt 0
          pageCtxNoModal, // [3] Post attempt 1
          pageCtxNoModal, // [4] Post attempt 2
          pageCtxNoModal, // [5] Post attempt 3
          pageCtxNoModal, // [6] Post attempt 4
        ],
      });

      const { restore } = installSleepSpy();
      let result: PublishResult;
      try {
        result = await publishApprovedFeedPostViaAction(deps);
      } finally {
        restore();
      }

      assert.equal(result.reason, "post_resolve_failed", "T-Resolve.2: reason must be 'post_resolve_failed'");
      assert.equal(
        result.dispatchAttempted,
        false,
        "T-Resolve.2: dispatchAttempted must be false (resolve failed pre-dispatch)",
      );
      assert.equal(result.fallbackAllowed, true, "T-Resolve.2: fallbackAllowed must be true (pre-dispatch failure)");

      // clickAt was called zero times on the dispatch (but zero times overall since initial was modal)
      assert.equal(
        clickAtLog.length,
        0,
        "T-Resolve.2: zero clickAt calls (initial modal, resolve fail before dispatch)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// §5.C T-Readback.1 — both read-back probes return false → reason:readback_mismatch
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPostViaAction — readback mismatch (T-Readback.1)", () => {
  it(
    "T-Readback.1: given verifyTypedTextOnSameTarget returns false on both probes, " +
      "when the action runs, " +
      "then result has reason:'readback_mismatch', dispatchAttempted:false, fallbackAllowed:true, " +
      "and zero clickAt on the Post resolver",
    async () => {
      // Given: both read-back probes return non-matching text.
      // When: publishApprovedFeedPostViaAction runs.
      // Then: reason:readback_mismatch; fallbackAllowed:true; Post clickAt=0.
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const scratchDir = join(tmpdir(), `frondose-s2-readback1-${Date.now()}`);
      mkdirSync(scratchDir, { recursive: true });

      const draftId = "draft-readback-1";
      const draftText = "intended text";
      seedDraft(join(scratchDir, "sales.db"), draftId, draftText);

      const clickAtLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];

      const client = makeFakeActionClient({
        urlQueue: ["https://www.linkedin.com/feed/"],
        navigateLog: [],
        evaluateResponses: new Map([
          ["activeElement", true], // FOCUS
          ["execCommand", true], // CLEAR
          // Editor returns mismatched text on BOTH probes
          ["editorText", JSON.stringify({ present: true, editorText: "wrong text entirely" })],
        ]),
        clickAtLog,
        raceHandleLog,
      });

      const auditRowLog: CapturedAuditRow[] = [];
      const modalCtx = makeModalContext();

      const deps = makePublishDeps({
        client,
        salesDbPath: join(scratchDir, "sales.db"),
        auditPath: join(scratchDir, "audit.jsonl"),
        draftId,
        auditRowLog,
        captureQueue: [modalCtx, modalCtx, modalCtx],
      });

      const { restore } = installSleepSpy();
      let result: PublishResult;
      try {
        result = await publishApprovedFeedPostViaAction(deps);
      } finally {
        restore();
      }

      assert.equal(result.reason, "readback_mismatch", "T-Readback.1: reason must be 'readback_mismatch'");
      assert.equal(result.dispatchAttempted, false, "T-Readback.1: dispatchAttempted must be false");
      assert.equal(result.fallbackAllowed, true, "T-Readback.1: fallbackAllowed must be true");
      // No dispatch click was attempted
      assert.equal(clickAtLog.length, 0, "T-Readback.1: zero clickAt calls (failed before Post dispatch)");
    },
  );
});

// ---------------------------------------------------------------------------
// §5.C T-Advice.1 — audit row contains OutwardActionAdvice with kind:remember_recommended
//                    AND interaction:'post' (commit-phase wiring)
//
// Step 3a revision (BLOCKER-2 + CONCERN-MR-3 resolution):
//   The §6.2 call uses the REAL commit-options shape:
//     buildOutwardActionAdvice("post", postResolved.context, {
//       phase: "commit", rememberInteraction: "post", useIdentityAnchor: true
//     })
//   A bare "post" descriptor defaults to phase:"draft" (outwardAction.ts) which does NOT
//   emit remember_recommended (only phase:"commit" does).
//   This assertion verifies BOTH kind==="remember_recommended" AND interaction==="post".
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPostViaAction — advice wiring (T-Advice.1)", () => {
  it(
    "T-Advice.1: given the happy-path run completes with " +
      "buildOutwardActionAdvice('post', context, {phase:'commit',rememberInteraction:'post',useIdentityAnchor:true}), " +
      "when the audit row is inspected, " +
      "then output.advice contains at least one OutwardActionAdvice entry with " +
      "kind==='remember_recommended' AND interaction==='post' " +
      "(commit-phase; bare 'post' descriptor defaults to phase:'draft' — would NOT emit remember_recommended)",
    async () => {
      // Given: happy-path run with empty deps (conservative defaults).
      // When: audit row is inspected after publishApprovedFeedPostViaAction.
      // Then: output.advice array contains entry with kind:'remember_recommended' AND interaction:'post'.
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const scratchDir = join(tmpdir(), `frondose-s2-advice1-${Date.now()}`);
      mkdirSync(scratchDir, { recursive: true });

      const draftId = "draft-advice-1";
      const draftText = "Advice test post";
      seedDraft(join(scratchDir, "sales.db"), draftId, draftText);

      const clickAtLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];

      const client = makeFakeActionClient({
        urlQueue: ["https://www.linkedin.com/feed/"],
        navigateLog: [],
        evaluateResponses: makeHappyEvalResponses(draftText),
        clickAtLog,
        raceHandleLog,
      });

      const auditRowLog: CapturedAuditRow[] = [];
      const modalCtx = makeModalContext();
      const deps = makePublishDeps({
        client,
        salesDbPath: join(scratchDir, "sales.db"),
        auditPath: join(scratchDir, "audit.jsonl"),
        draftId,
        auditRowLog,
        captureQueue: [modalCtx, modalCtx, modalCtx],
      });

      const { restore } = installSleepSpy();
      let result: PublishResult;
      try {
        result = await publishApprovedFeedPostViaAction(deps);
      } finally {
        restore();
      }

      assert.equal(result.published, true, "T-Advice.1 precondition: happy-path must publish");

      // result.advice contains OutwardActionAdvice entries directly
      const advice = result.advice;
      assert.ok(Array.isArray(advice) && advice.length > 0, "T-Advice.1: result.advice must be a non-empty array");

      const rememberEntry = (advice as Array<Record<string, unknown>>).find((a) => a.kind === "remember_recommended");
      assert.ok(
        rememberEntry !== undefined,
        "T-Advice.1: advice must contain an entry with kind='remember_recommended' (commit-phase wiring)",
      );
      assert.equal(
        (rememberEntry as Record<string, unknown>).interaction,
        "post",
        "T-Advice.1: remember_recommended entry must have interaction='post'",
      );

      // Also verify via audit row output
      const auditRow = auditRowLog[auditRowLog.length - 1];
      assert.ok(auditRow?.output !== undefined, "T-Advice.1: audit row output must be present");
      const outputAdvice = auditRow.output?.advice as Array<Record<string, unknown>> | undefined;
      assert.ok(
        Array.isArray(outputAdvice) && outputAdvice.length > 0,
        "T-Advice.1: audit row output.advice must be a non-empty array",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// §5.C T-Settle.1 — no post-dispatch navigate call
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPostViaAction — no post-dispatch navigate (T-Settle.1)", () => {
  it(
    "T-Settle.1: given a happy-path run, " +
      "when timings are observed, " +
      "then between the dispatch click and the result emission no further client.navigate is called",
    async () => {
      // Given: successful happy-path run.
      // When: all calls are logged via the fake client.
      // Then: navigateLog entries after the dispatch clickAt index = 0.
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const scratchDir = join(tmpdir(), `frondose-s2-settle1-${Date.now()}`);
      mkdirSync(scratchDir, { recursive: true });

      const draftId = "draft-settle-1";
      const draftText = "settle test";
      seedDraft(join(scratchDir, "sales.db"), draftId, draftText);

      const navigateLog: string[] = [];
      const clickAtLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];

      const client = makeFakeActionClient({
        urlQueue: ["https://www.linkedin.com/feed/"],
        navigateLog,
        evaluateResponses: makeHappyEvalResponses(draftText),
        clickAtLog,
        raceHandleLog,
      });

      const auditRowLog: CapturedAuditRow[] = [];
      const modalCtx = makeModalContext();
      const deps = makePublishDeps({
        client,
        salesDbPath: join(scratchDir, "sales.db"),
        auditPath: join(scratchDir, "audit.jsonl"),
        draftId,
        auditRowLog,
        captureQueue: [modalCtx, modalCtx, modalCtx],
      });

      const { restore } = installSleepSpy();
      let result: PublishResult;
      try {
        result = await publishApprovedFeedPostViaAction(deps);
      } finally {
        restore();
      }

      assert.equal(result.published, true, "T-Settle.1 precondition: happy-path must publish");

      // No navigate was called at all (already-on-feed fast path with reusedSession=true)
      assert.equal(navigateLog.length, 0, "T-Settle.1: no navigate calls at any point during the publish flow");
    },
  );
});

// ---------------------------------------------------------------------------
// §5.C T-Pacing.1 — applyTypingPacing called exactly once before typing loop
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPostViaAction — typing pacing (T-Pacing.1)", () => {
  it(
    "T-Pacing.1: given the action types 'abcdefg' via per-char Input.insertText, " +
      "when timings are observed, " +
      "then (a) applyTypingPacing('abcdefg') is awaited EXACTLY ONCE in publishApprovedFeedPostViaAction " +
      "immediately before the fillComposerSurface call (orchestration-level pre-delay per blueprint §3 step 5), " +
      "AND (b) inside fillComposerSurface's per-char loop, each character's post-insert sleep is " +
      "the value returned by computeCharDelay(text.length, rand, prevChar)",
    async () => {
      // Given: draft text is 'abcdefg' (7 chars).
      // When: publishApprovedFeedPostViaAction runs (initial modal → no open-composer click).
      // Then (both assertions — CONCERN-MR-3 resolution, port BOTH pacing layers):
      //   (a) applyTypingPacing awaited×1 before fillComposerSurface
      //       → one sleep in [160, 230ms] (extraDelay=56 for 7-char text, base=110)
      //   (b) inside fillComposerSurface per-char loop:
      //       7 chars → 7 per-char sleeps in [30, 150ms] each
      //
      // Full sleepLog for fast-path (initial modal, no scope retries, first probe matches):
      //   [0] = 300ms (SETTLE_AFTER_NAV_MS — ensureLinkedInDestination)
      //   [1] = 90ms (INPUT_READY_SETTLE_MS — ensureInputReady)
      //   [2] = applyTypingPacing result ∈ [166, 221ms]
      //   [3..9] = 7 per-char computeCharDelay values ∈ [30, 150ms] each
      //   [10] = 90ms (TARGET_READY_SETTLE_MS — ensureTargetReady)
      //
      // Position [2] is the typing pacing sleep (>= 160ms, distinct from settle sleeps).
      // Positions [3..9] are per-char sleeps.
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const scratchDir = join(tmpdir(), `frondose-s2-pacing1-${Date.now()}`);
      mkdirSync(scratchDir, { recursive: true });

      const draftId = "draft-pacing-1";
      const draftText = "abcdefg"; // 7 chars, no spaces → all insertText
      seedDraft(join(scratchDir, "sales.db"), draftId, draftText);

      const clickAtLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];

      const client = makeFakeActionClient({
        urlQueue: ["https://www.linkedin.com/feed/"],
        navigateLog: [],
        evaluateResponses: makeHappyEvalResponses(draftText),
        clickAtLog,
        raceHandleLog,
      });

      const auditRowLog: CapturedAuditRow[] = [];
      const modalCtx = makeModalContext();
      const deps = makePublishDeps({
        client,
        salesDbPath: join(scratchDir, "sales.db"),
        auditPath: join(scratchDir, "audit.jsonl"),
        draftId,
        auditRowLog,
        // Initial modal → no open-composer click, no scope retries
        captureQueue: [modalCtx, modalCtx, modalCtx],
      });

      const { sleepLog, restore } = installSleepSpy();
      let result: PublishResult;
      try {
        result = await publishApprovedFeedPostViaAction(deps);
      } finally {
        restore();
      }

      assert.equal(result.published, true, "T-Pacing.1 precondition: must publish");

      // Total sleeps for fast-path with 7-char text and first-probe match:
      // 1 (ensureLinkedInDest) + 1 (ensureInputReady) + 1 (applyTypingPacing) + 7 (per-char) + 1 (ensureTargetReady) = 11
      assert.equal(
        sleepLog.length,
        11,
        `T-Pacing.1: expected 11 total sleeps, got ${sleepLog.length}: [${sleepLog.join(",")}]`,
      );

      // sleepLog[0] = SETTLE_AFTER_NAV_MS = 300
      assert.ok(
        sleepLog[0] >= 280 && sleepLog[0] <= 350,
        `T-Pacing.1: sleep[0] must be ~300ms (SETTLE_AFTER_NAV_MS), got ${sleepLog[0]}ms`,
      );

      // sleepLog[1] = INPUT_READY_SETTLE_MS = 90
      assert.ok(
        sleepLog[1] >= 80 && sleepLog[1] <= 120,
        `T-Pacing.1: sleep[1] must be ~90ms (INPUT_READY_SETTLE_MS), got ${sleepLog[1]}ms`,
      );

      // sleepLog[2] = applyTypingPacing for 'abcdefg':
      // extraDelay = min(max(7*8, 20), 220) = min(56, 220) = 56
      // sleep = DEFAULT_SERIAL_BASE_DELAY_MS(110) + 56 + jitter[0,55] = [166, 221]ms
      assert.ok(
        sleepLog[2] >= 160 && sleepLog[2] <= 230,
        `T-Pacing.1 (a): sleep[2] must be the applyTypingPacing sleep in [160, 230ms], got ${sleepLog[2]}ms`,
      );

      // sleepLog[3..9] = 7 per-char computeCharDelay values
      // computeCharDelay(7, rand, prevChar) for non-space chars: floor=30, budget=150
      // Result ∈ [30, 150ms]
      const perCharSleeps = sleepLog.slice(3, 10);
      assert.equal(perCharSleeps.length, 7, "T-Pacing.1 (b): exactly 7 per-char sleeps for 'abcdefg'");
      for (const [idx, ms] of perCharSleeps.entries()) {
        assert.ok(
          ms >= 30 && ms <= 150,
          `T-Pacing.1 (b): per-char sleep[${idx + 3}] must be in [30, 150ms] (computeCharDelay range), got ${ms}ms`,
        );
      }

      // sleepLog[10] = TARGET_READY_SETTLE_MS = 90
      assert.ok(
        sleepLog[10] >= 80 && sleepLog[10] <= 120,
        `T-Pacing.1: sleep[10] must be ~90ms (TARGET_READY_SETTLE_MS), got ${sleepLog[10]}ms`,
      );

      // (a) exactly 1 sleep in the applyTypingPacing range [160, 230ms]
      const pacingSleeps = sleepLog.filter((ms) => ms >= 160 && ms <= 230);
      assert.equal(pacingSleeps.length, 1, "T-Pacing.1 (a): exactly ONE applyTypingPacing sleep in [160, 230ms]");

      // 7 insertText raceHandle calls
      const insertTextCalls = raceHandleLog.filter((e) => e.label === "Input.insertText");
      assert.equal(
        insertTextCalls.length,
        7,
        "T-Pacing.1 (b): exactly 7 Input.insertText raceHandle calls for 'abcdefg'",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// §5.C T-AuthInterrupt.1 — ensureLinkedInDestination throws → auth_interrupted
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPostViaAction — auth interruption (T-AuthInterrupt.1)", () => {
  it(
    "T-AuthInterrupt.1: given ensureLinkedInDestination throws an auth-interruption Error, " +
      "when the action runs, " +
      "then result has reason:'auth_interrupted', dispatchAttempted:false, fallbackAllowed:true, " +
      "and zero clickAt",
    async () => {
      // Given: getCurrentUrl returns a checkpoint URL → auth interruption throw.
      // When: publishApprovedFeedPostViaAction runs.
      // Then: reason:auth_interrupted; fallbackAllowed:true; clickAt×0.
      const { publishApprovedFeedPostViaAction } = await loadPublish();
      const scratchDir = join(tmpdir(), `frondose-s2-auth1-${Date.now()}`);
      mkdirSync(scratchDir, { recursive: true });

      const draftId = "draft-auth-1";
      const draftText = "auth interrupt test";
      seedDraft(join(scratchDir, "sales.db"), draftId, draftText);

      const clickAtLog: string[] = [];
      const raceHandleLog: Array<{ label: string; text?: string }> = [];

      // getCurrentUrl returns a checkpoint URL → ensureLinkedInDestination throws
      const client = makeFakeActionClient({
        urlQueue: ["https://www.linkedin.com/checkpoint/challenge"],
        navigateLog: [],
        evaluateResponses: new Map(),
        clickAtLog,
        raceHandleLog,
      });

      const auditRowLog: CapturedAuditRow[] = [];
      const modalCtx = makeModalContext();
      const deps = makePublishDeps({
        client,
        salesDbPath: join(scratchDir, "sales.db"),
        auditPath: join(scratchDir, "audit.jsonl"),
        draftId,
        auditRowLog,
        captureQueue: [modalCtx],
      });

      const { restore } = installSleepSpy();
      let result: PublishResult;
      try {
        result = await publishApprovedFeedPostViaAction(deps);
      } finally {
        restore();
      }

      assert.equal(result.reason, "auth_interrupted", "T-AuthInterrupt.1: reason must be 'auth_interrupted'");
      assert.equal(result.dispatchAttempted, false, "T-AuthInterrupt.1: dispatchAttempted must be false");
      assert.equal(result.fallbackAllowed, true, "T-AuthInterrupt.1: fallbackAllowed must be true (pre-dispatch)");
      assert.equal(clickAtLog.length, 0, "T-AuthInterrupt.1: zero clickAt calls on auth interruption");
    },
  );
});
