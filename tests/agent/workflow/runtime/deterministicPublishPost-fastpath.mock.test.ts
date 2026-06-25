/**
 * P-POST-PUBLISH-10 Step 2 — Outside-in TDD scaffold (validator, Sonnet)
 * Tests for the TARGET 1 fast-path: when the composer is ALREADY open with the
 * correct draft text, skip close+open+clear+insert and go straight to
 * focus → readback → post-button → click.
 *
 * Behaviors covered (plan §5):
 *   T-FastPath.1 — fast-path success (already-open + matching text → skip close/open/clear/insert)
 *   T-FastPath.2 — stale text → falls into existing P9 close+reopen path
 *   T-FastPath.3 — fast-path re-probe drift → readback_mismatch
 *   T-FastPath.4 — no-double-post invariant on fast-path (dispatchAttempted set once)
 *   T-FastPath.5 — fast-path + post_button_not_enabled → safe pre-dispatch fail
 *   T-FastPath.6 — surface check runs BEFORE the fast-path branch (call-order pin)
 *
 * ALL assertion bodies are TODO / assert.fail — MUST FAIL on HEAD
 * (the fast-path conditional branch does NOT exist yet; on HEAD an already-open
 * composer with matching text triggers the P9 close+reopen path which
 * calls closeFeedComposerLive/triggerStartAPostLive, causing "not called" assertions to fail).
 *
 * Harness: reuses the queue-based fake CdpClient + seedDraft + makePublishDeps idiom
 * from deterministicPublishPost-open.mock.test.ts (P9). The two files share the same
 * harness shape; constants loaded dynamically from composerReadiness.js at test-body time.
 *
 * Runner:
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/workflow/runtime/deterministicPublishPost-fastpath.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CdpClient } from "../../../../src/cdp/client.js";

// Disable inter-tool pacing.
process.env.FRONDOSE_PACE_MIN_MS = "0";

// ---------------------------------------------------------------------------
// Root path (for source-introspection test T-FastPath.4)
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, "../../../..");
const PUBLISH_SRC = readFileSync(
  resolve(ROOT, "src/agent/workflow/runtime/deterministicPublishPost.ts"),
  "utf-8",
);

// ---------------------------------------------------------------------------
// Payload-constant loader (same pattern as P9 open.mock.test.ts)
// ---------------------------------------------------------------------------

const SENTINEL_PROBE = "__P10_SENTINEL_PROBE__";
const SENTINEL_FOCUS = "__P10_SENTINEL_FOCUS__";
const SENTINEL_CLEAR = "__P10_SENTINEL_CLEAR__";
const SENTINEL_ENABLED = "__P10_SENTINEL_ENABLED__";
const SENTINEL_CENTER = "__P10_SENTINEL_POST_CENTER__";
const SENTINEL_TRIGGER = "__P10_SENTINEL_TRIGGER__";
const SENTINEL_CLOSE_CENTER = "__P10_SENTINEL_CLOSE_CENTER__";
const SENTINEL_DISCARD_CENTER = "__P10_SENTINEL_DISCARD_CENTER__";

interface PayloadConstants {
  PROBE_JS: string;
  FOCUS_JS: string;
  CLEAR_JS: string;
  ENABLED_JS: string;
  CENTER_JS: string;
  TRIGGER_JS: string;
  CLOSE_CENTER_JS: string;
  DISCARD_CENTER_JS: string;
}

async function loadPayloadConstants(): Promise<PayloadConstants> {
  try {
    const mod = (await import(
      "../../../../src/linkedin/composerReadiness.js"
    )) as Record<string, unknown>;
    return {
      PROBE_JS:
        (mod["FEED_COMPOSER_LIVE_IN_DOM_JS"] as string | undefined) ??
        SENTINEL_PROBE,
      FOCUS_JS:
        (mod["FEED_COMPOSER_FOCUS_JS"] as string | undefined) ??
        (mod["FEED_COMPOSER_FOCUS_EDITOR_JS"] as string | undefined) ??
        SENTINEL_FOCUS,
      CLEAR_JS:
        (mod["FEED_COMPOSER_CLEAR_JS"] as string | undefined) ??
        SENTINEL_CLEAR,
      ENABLED_JS:
        (mod["FEED_COMPOSER_POST_ENABLED_JS"] as string | undefined) ??
        SENTINEL_ENABLED,
      CENTER_JS:
        (mod["FEED_COMPOSER_POST_CENTER_JS"] as string | undefined) ??
        SENTINEL_CENTER,
      TRIGGER_JS:
        (mod["FEED_START_A_POST_CENTER_JS"] as string | undefined) ??
        SENTINEL_TRIGGER,
      CLOSE_CENTER_JS:
        (mod["FEED_COMPOSER_CLOSE_CENTER_JS"] as string | undefined) ??
        SENTINEL_CLOSE_CENTER,
      DISCARD_CENTER_JS:
        (mod["FEED_COMPOSER_DISCARD_CENTER_JS"] as string | undefined) ??
        SENTINEL_DISCARD_CENTER,
    };
  } catch {
    return {
      PROBE_JS: SENTINEL_PROBE,
      FOCUS_JS: SENTINEL_FOCUS,
      CLEAR_JS: SENTINEL_CLEAR,
      ENABLED_JS: SENTINEL_ENABLED,
      CENTER_JS: SENTINEL_CENTER,
      TRIGGER_JS: SENTINEL_TRIGGER,
      CLOSE_CENTER_JS: SENTINEL_CLOSE_CENTER,
      DISCARD_CENTER_JS: SENTINEL_DISCARD_CENTER,
    };
  }
}

// ---------------------------------------------------------------------------
// Queue-based fake CdpClient harness (mirrors P9 open.mock.test.ts exactly)
//
// Each payload key maps to a FIFO queue (Array.shift()). When the queue is
// exhausted, the last value is repeated. This allows the same JS constant to
// return different results on successive calls — which T-FastPath.3 requires
// (entry probe matches, re-probe after focus does not).
//
// Call-count tracking added for T-FastPath.1/.2/.4:
//   closeFeedComposerCallCount — counts CLOSE_CENTER_JS evaluate calls
//   triggerCallCount           — counts TRIGGER_JS calls (excluding the surface check)
//   clearCallCount             — counts CLEAR_JS evaluate calls
//   insertTextLog              — Input.insertText calls (captures text)
//   focusCallCount             — counts FOCUS_JS evaluate calls
//   dispatchClickLog           — spy on dispatchHumanLikeClickAtCoords
// ---------------------------------------------------------------------------

interface P10FakeClientOpts {
  constants: PayloadConstants;
  // FIFO probe queue for probeFeedComposerLive calls.
  probeQueue: Array<{ present: boolean; editorText: string }>;
  // TRIGGER_JS results: surface-check uses surfaceCheckQueue[0]; subsequent calls use triggerQueue.
  triggerQueue: Array<{ cx: number; cy: number } | null>;
  surfaceCheckQueue: Array<{ cx: number; cy: number } | null>;
  // CLOSE_CENTER_JS results.
  closeCenterQueue: Array<{ cx: number; cy: number } | null>;
  // DISCARD_CENTER_JS results.
  discardCenterQueue: Array<{ cx: number; cy: number } | null>;
  // FOCUS_JS result (boolean).
  focusResult: boolean;
  // CLEAR_JS result (boolean).
  clearResult: boolean;
  // ENABLED_JS: FIFO queue of booleans.
  enabledQueue: boolean[];
  // POST_CENTER_JS: single result.
  postCenterResult: { cx: number; cy: number } | null;
  // Spy logs (passed in, mutated by the fake client):
  pressKeyLog: string[];
  dispatchClickLog: Array<{ x: number; y: number }>;
  insertTextLog: Array<{ text: string }>;
  // Per-function call counters:
  closeEvaluateCallCount: { n: number };
  triggerEvaluateCallCount: { n: number };
  clearEvaluateCallCount: { n: number };
  focusEvaluateCallCount: { n: number };
  // F-2 (critic finding): counts every PROBE_JS (FEED_COMPOSER_LIVE_IN_DOM_JS) evaluate call.
  // This lets T-FastPath.6 assert exactly ONE probe ran (the secondary probe inside
  // surfaceLooksComposerCapable) when FEED_START_A_POST_CENTER_JS returns null, proving
  // the main entry probe / fast-path logic never ran (the surface check short-circuited first).
  probeEvaluateCallCount: { n: number };
}

function peekOrLast<T>(queue: T[]): T | undefined {
  if (queue.length === 0) return undefined;
  return queue.length === 1 ? queue[0] : queue.shift();
}

function makeFakeP10Client(opts: P10FakeClientOpts): CdpClient {
  const { constants: c } = opts;
  let enabledIdx = 0;
  let surfaceCheckConsumed = false;

  const fakeHandle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({ nodes: [] }),
    },
    Runtime: {
      evaluate: async (args: { expression: string }) => {
        const expr = args.expression;

        // CLOSE_CENTER_JS — must precede PROBE to avoid any overlap
        if (expr === c.CLOSE_CENTER_JS) {
          opts.closeEvaluateCallCount.n++;
          const raw = peekOrLast(opts.closeCenterQueue) ?? null;
          return { result: { value: JSON.stringify(raw) } };
        }
        // DISCARD_CENTER_JS
        if (expr === c.DISCARD_CENTER_JS) {
          const raw = peekOrLast(opts.discardCenterQueue) ?? null;
          return { result: { value: JSON.stringify(raw) } };
        }
        // POST_CENTER_JS (getFeedComposerPostButtonCenterLive)
        if (expr === c.CENTER_JS) {
          return { result: { value: JSON.stringify(opts.postCenterResult) } };
        }
        // TRIGGER_JS (FEED_START_A_POST_CENTER_JS)
        // First call → surfaceCheckQueue; subsequent calls → triggerQueue.
        if (expr === c.TRIGGER_JS) {
          let raw: { cx: number; cy: number } | null;
          if (!surfaceCheckConsumed && opts.surfaceCheckQueue.length > 0) {
            raw = peekOrLast(opts.surfaceCheckQueue) ?? null;
            surfaceCheckConsumed = true;
          } else {
            opts.triggerEvaluateCallCount.n++;
            raw = peekOrLast(opts.triggerQueue) ?? null;
          }
          return { result: { value: JSON.stringify(raw) } };
        }
        // ENABLED_JS
        if (expr === c.ENABLED_JS) {
          const res =
            enabledIdx < opts.enabledQueue.length
              ? opts.enabledQueue[enabledIdx++]
              : false;
          return { result: { value: res } };
        }
        // PROBE_JS (FEED_COMPOSER_LIVE_IN_DOM_JS)
        // Increment probeEvaluateCallCount on EVERY probe call (F-2: T-FastPath.6 pin).
        if (expr === c.PROBE_JS) {
          opts.probeEvaluateCallCount.n++;
          const res = peekOrLast(opts.probeQueue) ?? {
            present: false,
            editorText: "",
          };
          return { result: { value: JSON.stringify(res) } };
        }
        // FOCUS_JS
        if (expr === c.FOCUS_JS) {
          opts.focusEvaluateCallCount.n++;
          return { result: { value: opts.focusResult } };
        }
        // CLEAR_JS
        if (expr === c.CLEAR_JS) {
          opts.clearEvaluateCallCount.n++;
          return { result: { value: opts.clearResult } };
        }

        // Fallback sentinel routing (when sentinels are in use and expressions differ)
        if (expr.includes("CLOSE_RE") || expr.includes("FEED_COMPOSER_CLOSE")) {
          opts.closeEvaluateCallCount.n++;
          return { result: { value: JSON.stringify(null) } };
        }
        if (expr.includes("DISCARD_RE") || expr.includes("FEED_COMPOSER_DISCARD")) {
          return { result: { value: JSON.stringify(null) } };
        }
        if (expr.includes("Start a post") || expr.includes("START_RE") || expr.includes("start|create")) {
          let raw: { cx: number; cy: number } | null;
          if (!surfaceCheckConsumed && opts.surfaceCheckQueue.length > 0) {
            raw = peekOrLast(opts.surfaceCheckQueue) ?? null;
            surfaceCheckConsumed = true;
          } else {
            opts.triggerEvaluateCallCount.n++;
            raw = peekOrLast(opts.triggerQueue) ?? null;
          }
          return { result: { value: JSON.stringify(raw) } };
        }
        if (
          expr.includes("button.disabled") ||
          expr.includes("POST_RE") ||
          expr.includes("post_button")
        ) {
          const res =
            enabledIdx < opts.enabledQueue.length
              ? opts.enabledQueue[enabledIdx++]
              : false;
          return { result: { value: res } };
        }
        if (
          expr.includes("el.focus()") ||
          expr.includes("activeElement") ||
          expr.includes("FOCUS")
        ) {
          opts.focusEvaluateCallCount.n++;
          return { result: { value: opts.focusResult } };
        }
        if (
          expr.includes("deleteContentBackward") ||
          expr.includes("selectAll") ||
          expr.includes("CLEAR")
        ) {
          opts.clearEvaluateCallCount.n++;
          return { result: { value: opts.clearResult } };
        }
        // Default: treat as probe (also counts toward probeEvaluateCallCount for F-2 tracking)
        opts.probeEvaluateCallCount.n++;
        const res = peekOrLast(opts.probeQueue) ?? {
          present: false,
          editorText: "",
        };
        return { result: { value: JSON.stringify(res) } };
      },
    },
    DOM: {
      getDocument: async () => ({ root: { nodeId: 1 } }),
      querySelectorAll: async () => ({ nodeIds: [] }),
      scrollIntoViewIfNeeded: async () => {},
      getBoxModel: async () => ({
        model: { border: [0, 0, 10, 0, 10, 10, 0, 10] },
      }),
    },
    Input: {
      dispatchMouseEvent: async (args: {
        type: string;
        x?: number;
        y?: number;
      }) => {
        void args;
      },
      dispatchKeyEvent: async (_args: unknown) => {},
      insertText: async (args: { text: string }) => {
        opts.insertTextLog.push({ text: args.text });
      },
      synthesizeScrollGesture: async () => {},
    },
    Browser: { close: async () => {} },
    Page: {
      enable: async () => {},
      navigate: async () => ({}),
      loadEventFired: (cb: (p: unknown) => void) => {
        setTimeout(() => cb({ timestamp: 0 }), 0);
        return () => {};
      },
      frameNavigated: (cb: (p: unknown) => void) => {
        setTimeout(() => cb({ frame: { url: "" } }), 0);
        return () => {};
      },
      lifecycleEvent: (cb: (p: unknown) => void) => {
        setTimeout(() => cb({ name: "networkIdle" }), 0);
        return () => {};
      },
      setLifecycleEventsEnabled: async () => {},
      getLayoutMetrics: async () => ({
        visualViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: 1440,
          clientHeight: 900,
        },
        cssVisualViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: 1440,
          clientHeight: 900,
        },
        cssLayoutViewport: { clientWidth: 1440, clientHeight: 900 },
      }),
      reload: async () => {},
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);

  // Override pressKey spy.
  const origPressKey = client.pressKey.bind(client);
  client.pressKey = async (key: string) => {
    opts.pressKeyLog.push(key);
    return origPressKey(key);
  };

  // Override dispatchHumanLikeClickAtCoords spy.
  const origDispatch = client.dispatchHumanLikeClickAtCoords.bind(client);
  client.dispatchHumanLikeClickAtCoords = async (x: number, y: number) => {
    opts.dispatchClickLog.push({ x, y });
    return origDispatch(x, y);
  };

  return client;
}

// ---------------------------------------------------------------------------
// Draft seeding helper (mirrors P9 deterministicPublishPost-open.mock.test.ts)
// ---------------------------------------------------------------------------

interface ScratchSetup {
  scratchDir: string;
  auditPath: string;
  dbPath: string;
  draftId: string;
}

async function seedDraft(
  label: string,
  text: string,
): Promise<ScratchSetup> {
  const scratchDir = join(tmpdir(), `frondose-p10-fp-${label}`, `${Date.now()}`);
  mkdirSync(scratchDir, { recursive: true });
  const auditPath = join(scratchDir, "audit.jsonl");
  const dbPath = join(scratchDir, "sales.db");

  try {
    const dbMod = (await import(
      "../../../../src/tools/sales/_dbHandle.js"
    )) as Record<string, unknown>;
    const getSalesDb = dbMod["getSalesDb"] as
      | ((p: string) => unknown)
      | undefined;
    const draftsMod = (await import(
      "../../../../src/persistence/sales/drafts.js"
    )) as Record<string, unknown>;
    const insertDraft = draftsMod["insertDraft"] as
      | ((
          db: unknown,
          input: {
            leadId: null;
            kind: string;
            text: string;
            createdBy: string;
          },
        ) => string)
      | undefined;
    if (typeof getSalesDb === "function" && typeof insertDraft === "function") {
      const db = getSalesDb(dbPath);
      const draftId = insertDraft(db, {
        leadId: null,
        kind: "post",
        text,
        createdBy: "llm",
      });
      return { scratchDir, auditPath, dbPath, draftId };
    }
  } catch {
    // pre-Step-4: helpers may not yet exist; test will hit assert.fail
  }
  return {
    scratchDir,
    auditPath,
    dbPath,
    draftId: "d-seed-unavailable",
  };
}

// ---------------------------------------------------------------------------
// Deps builder (mirrors P9 makePublishDeps exactly)
// ---------------------------------------------------------------------------

function makePublishDeps(
  client: CdpClient,
  setup: ScratchSetup,
  mode: "manual" | "auto" = "manual",
): Record<string, unknown> {
  return {
    session: {
      inputMode: "cdp" as const,
      getOrInitClient: () => Promise.resolve(client),
      getClient: () => client,
      setLastContext: () => {},
      getLastContext: () => undefined,
      resolvedMode: () => mode,
    },
    client,
    salesDbPath: setup.dbPath,
    auditPath: setup.auditPath,
    workflowDeps: {
      emitFrame: () => {},
      writeWorkflowAudit: () => {},
    },
    workflowId: "wf-p10-fp",
    stepId: "step-p10-fp",
    draftId: setup.draftId,
  };
}

// ---------------------------------------------------------------------------
// publishApprovedFeedPost dynamic import helper
// ---------------------------------------------------------------------------

type PublishResult = {
  published: boolean;
  reason?: string;
  fallbackAllowed: boolean;
  dispatchAttempted: boolean;
  draftMarkedSent?: boolean;
  accountingError?: string;
};

async function importPublishFn(): Promise<
  ((deps: unknown) => Promise<PublishResult>) | undefined
> {
  try {
    const mod = (await import(
      "../../../../src/agent/workflow/runtime/deterministicPublishPost.js"
    )) as Record<string, unknown>;
    return mod["publishApprovedFeedPost"] as
      | ((deps: unknown) => Promise<PublishResult>)
      | undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Shared fast-path client builder (happy-path conditions for T-FastPath.1/.4/.5 variants)
//
// Entry probe: {present:true, editorText:draftText} — matches draft → composerAlreadyValid=true.
// Re-probe (after focus): {present:true, editorText:draftText} — matches again → readback ok.
// Post-click post-probe: {present:false} — composer gone → success.
// surface-check: TRIGGER_JS → center (capable).
// triggerQueue: EMPTY (the fast-path must NOT consume trigger).
// closeCenterQueue: EMPTY (the fast-path must NOT evaluate CLOSE_CENTER_JS).
// clearResult: false (irrelevant — CLEAR_JS must NOT be evaluated on the fast-path).
// ---------------------------------------------------------------------------

function makeFastPathHappyClientOpts(
  constants: PayloadConstants,
  draftText: string,
  opts: {
    pressKeyLog: string[];
    dispatchClickLog: Array<{ x: number; y: number }>;
    insertTextLog: Array<{ text: string }>;
    closeEvaluateCallCount: { n: number };
    triggerEvaluateCallCount: { n: number };
    clearEvaluateCallCount: { n: number };
    focusEvaluateCallCount: { n: number };
    probeEvaluateCallCount: { n: number };
    enabledQueue?: boolean[];
    postCenterResult?: { cx: number; cy: number } | null;
    // Override re-probe queue for drift tests (T-FastPath.3)
    overrideProbeQueue?: Array<{ present: boolean; editorText: string }>;
  },
): P10FakeClientOpts {
  return {
    constants,
    // surface-check uses surfaceCheckQueue[0] → capable
    surfaceCheckQueue: [{ cx: 100, cy: 200 }],
    // Probe queue:
    //   [0] entry probe: present + matching text → composerAlreadyValid = true
    //   [1] re-probe after focus: still present + matching → readback matches
    //   [2] post-click probe: gone → composer_gone check passes
    probeQueue: opts.overrideProbeQueue ?? [
      { present: true, editorText: draftText },
      { present: true, editorText: draftText },
      { present: false, editorText: "" },
    ],
    // The fast-path MUST NOT call triggerStartAPostLive — these queues stay empty.
    triggerQueue: [],
    closeCenterQueue: [],
    discardCenterQueue: [],
    focusResult: true,
    clearResult: false, // irrelevant; CLEAR_JS must not be called
    enabledQueue: opts.enabledQueue ?? [true],
    postCenterResult: opts.postCenterResult !== undefined ? opts.postCenterResult : { cx: 480, cy: 320 },
    pressKeyLog: opts.pressKeyLog,
    dispatchClickLog: opts.dispatchClickLog,
    insertTextLog: opts.insertTextLog,
    closeEvaluateCallCount: opts.closeEvaluateCallCount,
    triggerEvaluateCallCount: opts.triggerEvaluateCallCount,
    clearEvaluateCallCount: opts.clearEvaluateCallCount,
    focusEvaluateCallCount: opts.focusEvaluateCallCount,
    probeEvaluateCallCount: opts.probeEvaluateCallCount,
  };
}

// ---------------------------------------------------------------------------
// T-FastPath.1 — fast-path success: close/open/clear/insert NOT called; focus=1; click=1
// ---------------------------------------------------------------------------

describe(
  "publishApprovedFeedPost — TARGET 1 fast-path: composer already open with matching text → success without close/open/clear/insert (T-FastPath.1, SC-1)",
  () => {
    it(
      "T-FastPath.1: when entry probe {present:true, editorText:<draft.text>} + readback also matches + button enabled + coords → {published:true}; close/trigger/clear/insert NOT called; focus called once; clickAtCoords called once",
      { timeout: 10000 },
      async () => {
        // Given: surface-check capable; entry probe present + editorText === draft.text
        //        (composerAlreadyValid = true); re-probe after focus still matches;
        //        post-button enabled; coords returned; close/trigger/clear/insertText NOT called.
        // When:  publishApprovedFeedPost is invoked.
        // Then:  closeFeedComposerLive NOT called (closeEvaluateCallCount=0);
        //        triggerStartAPostLive NOT called (triggerEvaluateCallCount=0);
        //        clearFeedComposerEditorLive NOT called (clearEvaluateCallCount=0);
        //        insertTextLog.length===0; focusEvaluateCallCount===1;
        //        dispatchClickLog.length===1 (Post-button click);
        //        result.published===true; result.dispatchAttempted===true; result.fallbackAllowed===false.
        //        NOTE on input.fastPath: if the implementation adds fastPath:true to the audit input,
        //        assert it is true. This assertion is TOLERATED-ABSENT (the field is optional per plan §3a).
        //        The test does NOT hard-fail if fastPath is absent from the audit — but IF present, it must be true.
        // Covers SC-1 (fast-path success).
        const constants = await loadPayloadConstants();
        const draftText = "FastPath.1 — already open with matching draft text";
        const setup = await seedDraft("fp1", draftText);

        const dispatchClickLog: Array<{ x: number; y: number }> = [];
        const pressKeyLog: string[] = [];
        const insertTextLog: Array<{ text: string }> = [];
        const closeEvaluateCallCount = { n: 0 };
        const triggerEvaluateCallCount = { n: 0 };
        const clearEvaluateCallCount = { n: 0 };
        const focusEvaluateCallCount = { n: 0 };
        const probeEvaluateCallCount = { n: 0 };

        const clientOpts = makeFastPathHappyClientOpts(constants, draftText, {
          pressKeyLog,
          dispatchClickLog,
          insertTextLog,
          closeEvaluateCallCount,
          triggerEvaluateCallCount,
          clearEvaluateCallCount,
          focusEvaluateCallCount,
          probeEvaluateCallCount,
        });
        const client = makeFakeP10Client(clientOpts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail("TODO P10: publishApprovedFeedPost not exported (Step 4 pending)");
        }
        const result = await fn(deps);

        // T-FastPath.1: fast-path must skip close/trigger/clear/insert; focus=1; click=1.
        assert.equal(closeEvaluateCallCount.n, 0, "T-FastPath.1: closeFeedComposerLive must NOT be called on fast-path");
        assert.equal(triggerEvaluateCallCount.n, 0, "T-FastPath.1: triggerStartAPostLive must NOT be called on fast-path");
        assert.equal(clearEvaluateCallCount.n, 0, "T-FastPath.1: clearFeedComposerEditorLive must NOT be called on fast-path");
        assert.equal(insertTextLog.length, 0, "T-FastPath.1: insertTextHumanLike must NOT be called on fast-path");
        assert.equal(focusEvaluateCallCount.n, 1, "T-FastPath.1: focusFeedComposerEditorLive must be called exactly once");
        assert.equal(dispatchClickLog.length, 1, "T-FastPath.1: dispatchHumanLikeClickAtCoords must be called exactly once (Post-button click)");
        assert.equal(result.published, true, "T-FastPath.1: result.published must be true");
        assert.equal(result.dispatchAttempted, true, "T-FastPath.1: result.dispatchAttempted must be true");
        assert.equal(result.fallbackAllowed, false, "T-FastPath.1: result.fallbackAllowed must be false");
        // Optional fastPath marker: if present, must be true (tolerated-absent per plan §3a).
        const auditRow = result as Record<string, unknown>;
        if (typeof auditRow["fastPath"] !== "undefined") {
          assert.equal(auditRow["fastPath"], true, "T-FastPath.1: if input.fastPath marker present, it must be true");
        }
      },
    );
  },
);

// ---------------------------------------------------------------------------
// T-FastPath.2 — stale/wrong text in open composer → falls to P9 close+reopen path
// ---------------------------------------------------------------------------

describe(
  "publishApprovedFeedPost — TARGET 1 fast-path: open composer with NON-matching text → P9 close+reopen path (T-FastPath.2, SC-2)",
  () => {
    it(
      "T-FastPath.2: when entry probe {present:true, editorText:'something else entirely'} + draft.text differs → composerAlreadyValid=false → closeFeedComposerLive IS called; triggerStartAPostLive IS called; insertTextHumanLike IS called",
      { timeout: 10000 },
      async () => {
        // Given: surface-check capable; entry probe present=true BUT editorText does NOT match draft.text
        //        (composerTextMatches returns false → composerAlreadyValid=false);
        //        close-retry succeeds; open-retry succeeds first round; focus/clear/insert/readback/enabled/coords/click happy-path.
        // When:  publishApprovedFeedPost is invoked.
        // Then:  closeFeedComposerLive IS called (closeEvaluateCallCount > 0);
        //        triggerStartAPostLive IS called (triggerEvaluateCallCount > 0);
        //        insertTextLog.length > 0 (insertTextHumanLike fired);
        //        result.published===true on success (or carries the matching P9 fail-reason on any pre-dispatch fail).
        // Covers SC-2 (stale-text fallback to P9 path).
        const constants = await loadPayloadConstants();
        const draftText = "FastPath.2 — correct draft text we intend to publish";
        const staleText = "something else entirely — stale editor content";
        const setup = await seedDraft("fp2-stale", draftText);

        const dispatchClickLog: Array<{ x: number; y: number }> = [];
        const pressKeyLog: string[] = [];
        const insertTextLog: Array<{ text: string }> = [];
        const closeEvaluateCallCount = { n: 0 };
        const triggerEvaluateCallCount = { n: 0 };
        const clearEvaluateCallCount = { n: 0 };
        const focusEvaluateCallCount = { n: 0 };
        const probeEvaluateCallCount = { n: 0 };

        const clientOpts: P10FakeClientOpts = {
          constants,
          surfaceCheckQueue: [{ cx: 100, cy: 200 }],
          // Entry probe: present but stale text → composerAlreadyValid = false → P9 path
          // closeFeedComposerLive sequence:
          //   1. pressKey("Escape") — no probe
          //   2. clickComposerDiscardControlIfPresent → DISCARD_CENTER_JS → null (no click)
          //   3. isFeedComposerLiveInDOM probe [1]: still present (Escape didn't dismiss it)
          //      → don't return early → proceed to CLOSE_CENTER_JS evaluation
          //   4. clickComposerControlAtCenter → CLOSE_CENTER_JS → returns {cx:50,cy:50} → click
          //   5. clickComposerDiscardControlIfPresent → DISCARD_CENTER_JS → null (no click)
          //   6. sleep → isFeedComposerLiveInDOM probe [2]: absent → return true (closed)
          // Then trigger:
          //   7. triggerStartAPostLive → TRIGGER_JS → returns center → click
          //   8. post-open probe [3]: present (empty) → open succeeded
          // Then focus+insert+readback:
          //   9. readback probe [4]: matches draftText
          //   10. post-click probe [5]: gone
          probeQueue: [
            { present: true, editorText: staleText },     // [0] entry probe: mismatch → P9 path
            { present: true, editorText: staleText },     // [1] close internal probe (after Escape): still present → go to CLOSE_CENTER_JS
            { present: false, editorText: "" },           // [2] close internal probe 2 (after close click): absent → closed=true
            { present: true, editorText: "" },            // [3] post-open probe after trigger: present (empty)
            { present: true, editorText: draftText },     // [4] readback 1: matches full draft
            { present: false, editorText: "" },           // [5] post-click probe 1: gone
          ],
          // closeFeedComposerLive needs a close-center to click
          closeCenterQueue: [{ cx: 50, cy: 50 }],
          discardCenterQueue: [null],
          triggerQueue: [{ cx: 100, cy: 200 }],  // trigger succeeds round 1
          focusResult: true,
          clearResult: true,
          enabledQueue: [true],
          postCenterResult: { cx: 480, cy: 320 },
          pressKeyLog,
          dispatchClickLog,
          insertTextLog,
          closeEvaluateCallCount,
          triggerEvaluateCallCount,
          clearEvaluateCallCount,
          focusEvaluateCallCount,
          probeEvaluateCallCount,
        };
        const client = makeFakeP10Client(clientOpts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail("TODO P10: publishApprovedFeedPost not exported (Step 4 pending)");
        }
        const result = await fn(deps);

        // T-FastPath.2: stale text → close+reopen+insert path must be taken.
        assert.ok(closeEvaluateCallCount.n > 0,
          `T-FastPath.2: closeFeedComposerLive must be called (closeEvaluateCallCount=${closeEvaluateCallCount.n})`);
        assert.ok(triggerEvaluateCallCount.n > 0,
          `T-FastPath.2: triggerStartAPostLive must be called (triggerEvaluateCallCount=${triggerEvaluateCallCount.n})`);
        // insertTextHumanLike inserts per-character; verify the FULL draftText is inserted.
        const insertedText = insertTextLog.map((e) => e.text).join("");
        assert.ok(insertTextLog.length > 0,
          "T-FastPath.2: insertTextHumanLike must be called (insertTextLog must not be empty)");
        assert.equal(insertedText, draftText,
          `T-FastPath.2: concatenation of insertTextLog must equal draft.text (got ${insertedText.length} chars, expected ${draftText.length})`);
        // The result should succeed end-to-end (P9 path with all mocks scripted to succeed).
        assert.equal(result.published, true, "T-FastPath.2: result.published must be true (P9 path succeeds)");
        assert.equal(result.dispatchAttempted, true, "T-FastPath.2: result.dispatchAttempted must be true");
        assert.equal(result.fallbackAllowed, false, "T-FastPath.2: result.fallbackAllowed must be false");
      },
    );
  },
);

// ---------------------------------------------------------------------------
// T-FastPath.3 — fast-path re-probe drift → readback_mismatch, no Post-click
// ---------------------------------------------------------------------------

describe(
  "publishApprovedFeedPost — TARGET 1 fast-path: entry matches but re-probe after focus drifts → readback_mismatch (T-FastPath.3, SC-3)",
  () => {
    it(
      "T-FastPath.3: when entry probe matches + composerAlreadyValid=true, but BOTH re-probes after focusFeedComposerEditorLive return non-matching text, result is {reason:'readback_mismatch', dispatchAttempted:false}; no close/trigger/clear/insert called; no Post-click",
      { timeout: 10000 },
      async () => {
        // Given: surface-check capable; entry probe: {present:true, editorText:draftText} (matches);
        //        focusFeedComposerEditorLive succeeds; re-probe 1 after focus: editorText="X" (mismatch);
        //        sleep(READBACK_RETRY_MS); re-probe 2: editorText="X" (still mismatch);
        //        → composerTextMatches returns false both times → readback_mismatch.
        // When:  publishApprovedFeedPost is invoked.
        // Then:  close/trigger/clear/insert NOT called; dispatchClickLog.length===0;
        //        result.reason==="readback_mismatch"; result.dispatchAttempted===false;
        //        result.fallbackAllowed===true.
        // Covers SC-3 (fast-path re-probe drift).
        const constants = await loadPayloadConstants();
        const draftText = "FastPath.3 — matching entry but drift after focus";
        const setup = await seedDraft("fp3-drift", draftText);

        const dispatchClickLog: Array<{ x: number; y: number }> = [];
        const pressKeyLog: string[] = [];
        const insertTextLog: Array<{ text: string }> = [];
        const closeEvaluateCallCount = { n: 0 };
        const triggerEvaluateCallCount = { n: 0 };
        const clearEvaluateCallCount = { n: 0 };
        const focusEvaluateCallCount = { n: 0 };
        const probeEvaluateCallCount = { n: 0 };

        // Override probe queue: entry matches, but re-probes (after focus) do not match.
        const driftedProbeQueue: Array<{ present: boolean; editorText: string }> = [
          { present: true, editorText: draftText },  // [0] entry probe: matches → fast-path
          { present: true, editorText: "X" },        // [1] re-probe 1 after focus: mismatch
          { present: true, editorText: "X" },        // [2] re-probe 2 (after sleep): still mismatch
        ];

        const clientOpts = makeFastPathHappyClientOpts(constants, draftText, {
          pressKeyLog,
          dispatchClickLog,
          insertTextLog,
          closeEvaluateCallCount,
          triggerEvaluateCallCount,
          clearEvaluateCallCount,
          focusEvaluateCallCount,
          probeEvaluateCallCount,
          overrideProbeQueue: driftedProbeQueue,
        });
        const client = makeFakeP10Client(clientOpts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail("TODO P10: publishApprovedFeedPost not exported (Step 4 pending)");
        }
        const result = await fn(deps);

        // T-FastPath.3: drift after focus → readback_mismatch, no dispatch.
        assert.equal(result.reason, "readback_mismatch", "T-FastPath.3: reason must be readback_mismatch");
        assert.equal(result.dispatchAttempted, false, "T-FastPath.3: dispatchAttempted must be false (no Post-click on mismatch)");
        assert.equal(result.fallbackAllowed, true, "T-FastPath.3: fallbackAllowed must be true (LLM can retry)");
        assert.equal(result.published, false, "T-FastPath.3: published must be false");
        // Fast-path: close/trigger/clear/insert must NOT be called.
        assert.equal(closeEvaluateCallCount.n, 0, "T-FastPath.3: closeFeedComposerLive must NOT be called");
        assert.equal(triggerEvaluateCallCount.n, 0, "T-FastPath.3: triggerStartAPostLive must NOT be called");
        assert.equal(clearEvaluateCallCount.n, 0, "T-FastPath.3: clearFeedComposerEditorLive must NOT be called");
        assert.equal(insertTextLog.length, 0, "T-FastPath.3: insertTextHumanLike must NOT be called");
        // Post-click must NOT have fired.
        assert.equal(dispatchClickLog.length, 0, "T-FastPath.3: no Post-button click must have been dispatched");
      },
    );
  },
);

// ---------------------------------------------------------------------------
// T-FastPath.4 — no-double-post invariant on the fast-path
// ---------------------------------------------------------------------------

describe(
  "publishApprovedFeedPost — TARGET 1 fast-path: no-double-post invariant — dispatchAttempted set exactly once, dispatchHumanLikeClickAtCoords called exactly once (T-FastPath.4, SC-4)",
  () => {
    it(
      "T-FastPath.4: fast-path success → dispatchHumanLikeClickAtCoords called exactly ONCE; source literal 'dispatchAttempted = true' appears exactly once in deterministicPublishPost.ts",
      { timeout: 10000 },
      async () => {
        // Given: same as T-FastPath.1 (fast-path happy-path).
        // When:  publishApprovedFeedPost is invoked.
        // Then:  dispatchClickLog.length === 1 (one Post-button click, never two);
        //        AND the source file deterministicPublishPost.ts contains the literal string
        //        'dispatchAttempted = true' exactly ONCE (no second assignment was added).
        //        This pins the no-double-post invariant at the source level (plan §2 pt 5, SC-4).
        // Covers SC-4 (no-double-post on the fast-path).
        const constants = await loadPayloadConstants();
        const draftText = "FastPath.4 — no-double-post invariant";
        const setup = await seedDraft("fp4-nodoublepost", draftText);

        const dispatchClickLog: Array<{ x: number; y: number }> = [];
        const pressKeyLog: string[] = [];
        const insertTextLog: Array<{ text: string }> = [];
        const closeEvaluateCallCount = { n: 0 };
        const triggerEvaluateCallCount = { n: 0 };
        const clearEvaluateCallCount = { n: 0 };
        const focusEvaluateCallCount = { n: 0 };
        const probeEvaluateCallCount = { n: 0 };

        const clientOpts = makeFastPathHappyClientOpts(constants, draftText, {
          pressKeyLog,
          dispatchClickLog,
          insertTextLog,
          closeEvaluateCallCount,
          triggerEvaluateCallCount,
          clearEvaluateCallCount,
          focusEvaluateCallCount,
          probeEvaluateCallCount,
        });
        const client = makeFakeP10Client(clientOpts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail("TODO P10: publishApprovedFeedPost not exported (Step 4 pending)");
        }
        const result = await fn(deps);

        // Source-level introspection: count occurrences of 'dispatchAttempted = true' in the source.
        // This must be exactly 1 regardless of whether the fast-path was taken.
        // (plan §5 T-FastPath.4: "the literal `dispatchAttempted = true` appears exactly once")
        const assignmentMatches = (PUBLISH_SRC.match(/dispatchAttempted\s*=\s*true/g) ?? []).length;

        // Behavioral: exactly one Post-button click dispatched (the fast-path fires exactly once).
        assert.equal(dispatchClickLog.length, 1,
          `T-FastPath.4: dispatchHumanLikeClickAtCoords must be called exactly once (got ${dispatchClickLog.length})`);
        // Structural: exactly one dispatchAttempted = true assignment in source code.
        assert.equal(assignmentMatches, 1,
          `T-FastPath.4: 'dispatchAttempted = true' must appear exactly once in deterministicPublishPost.ts (found ${assignmentMatches}). ` +
          "The no-double-post invariant requires a single assignment site — the P10 refactor must not have added a second.");
        // Result must be success.
        assert.equal(result.published, true, "T-FastPath.4: result.published must be true");
        assert.equal(result.dispatchAttempted, true, "T-FastPath.4: result.dispatchAttempted must be true");
      },
    );
  },
);

// ---------------------------------------------------------------------------
// T-FastPath.5 — fast-path + post_button_not_enabled → safe pre-dispatch fail
// ---------------------------------------------------------------------------

describe(
  "publishApprovedFeedPost — TARGET 1 fast-path: post button not enabled on both attempts → post_button_not_enabled (T-FastPath.5, SC-5)",
  () => {
    it(
      "T-FastPath.5: when fast-path entry conditions hold (composerAlreadyValid=true) but isFeedComposerPostButtonEnabled returns false on both attempts, result is {reason:'post_button_not_enabled', dispatchAttempted:false, fallbackAllowed:true}",
      { timeout: 10000 },
      async () => {
        // Given: surface capable; entry probe matches draft.text; focus succeeds; readback matches;
        //        BUT isFeedComposerPostButtonEnabled returns false on both poll attempts.
        // When:  publishApprovedFeedPost is invoked.
        // Then:  result.reason==="post_button_not_enabled"; result.dispatchAttempted===false;
        //        result.fallbackAllowed===true; dispatchClickLog.length===0 (no Post-click fired).
        //        close/trigger/clear/insert NOT called.
        // Covers SC-5 (fast-path post_button_not_enabled).
        const constants = await loadPayloadConstants();
        const draftText = "FastPath.5 — matching text but button disabled";
        const setup = await seedDraft("fp5-btndisabled", draftText);

        const dispatchClickLog: Array<{ x: number; y: number }> = [];
        const pressKeyLog: string[] = [];
        const insertTextLog: Array<{ text: string }> = [];
        const closeEvaluateCallCount = { n: 0 };
        const triggerEvaluateCallCount = { n: 0 };
        const clearEvaluateCallCount = { n: 0 };
        const focusEvaluateCallCount = { n: 0 };
        const probeEvaluateCallCount = { n: 0 };

        const clientOpts = makeFastPathHappyClientOpts(constants, draftText, {
          pressKeyLog,
          dispatchClickLog,
          insertTextLog,
          closeEvaluateCallCount,
          triggerEvaluateCallCount,
          clearEvaluateCallCount,
          focusEvaluateCallCount,
          probeEvaluateCallCount,
          enabledQueue: [false, false], // both poll attempts return false
          postCenterResult: { cx: 480, cy: 320 }, // irrelevant — button-enabled check exits first
        });
        const client = makeFakeP10Client(clientOpts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail("TODO P10: publishApprovedFeedPost not exported (Step 4 pending)");
        }
        const result = await fn(deps);

        // T-FastPath.5: button never enabled → post_button_not_enabled, no dispatch.
        assert.equal(result.reason, "post_button_not_enabled", "T-FastPath.5: reason must be post_button_not_enabled");
        assert.equal(result.dispatchAttempted, false, "T-FastPath.5: dispatchAttempted must be false (no click before button enabled)");
        assert.equal(result.fallbackAllowed, true, "T-FastPath.5: fallbackAllowed must be true (LLM can retry)");
        assert.equal(result.published, false, "T-FastPath.5: published must be false");
        assert.equal(dispatchClickLog.length, 0, "T-FastPath.5: no Post-button click must have been dispatched");
        // Fast-path: close/trigger/clear/insert must NOT be called.
        assert.equal(closeEvaluateCallCount.n, 0, "T-FastPath.5: closeFeedComposerLive must NOT be called on fast-path");
        assert.equal(triggerEvaluateCallCount.n, 0, "T-FastPath.5: triggerStartAPostLive must NOT be called on fast-path");
        assert.equal(clearEvaluateCallCount.n, 0, "T-FastPath.5: clearFeedComposerEditorLive must NOT be called on fast-path");
        assert.equal(insertTextLog.length, 0, "T-FastPath.5: insertTextHumanLike must NOT be called on fast-path");
      },
    );
  },
);

// ---------------------------------------------------------------------------
// T-FastPath.6 — surface check runs BEFORE the fast-path (call order pin)
// F-2 (critic finding) addressed here: probeEvaluateCallCount is now tracked so
// the test can assert EXACTLY ONE PROBE_JS evaluate ran (the secondary probe inside
// surfaceLooksComposerCapable) when FEED_START_A_POST_CENTER_JS returns null, AND
// zero focus/close/clear/insert/Post-click — making the call-order claim non-vacuous.
// ---------------------------------------------------------------------------

describe(
  "publishApprovedFeedPost — TARGET 1 fast-path: surfaceLooksComposerCapable runs BEFORE entry probe + fast-path branch (T-FastPath.6, SC-6, F-2 probe-counter pin)",
  () => {
    it(
      "T-FastPath.6: when FEED_START_A_POST_CENTER_JS returns null + secondary probe absent, runtime returns {reason:'surface_not_composer_capable'}; EXACTLY ONE PROBE_JS evaluate ran (secondary probe inside surfaceLooksComposerCapable); no focus/close/clear/insert/Post-click",
      { timeout: 10000 },
      async () => {
        // Given: surfaceLooksComposerCapable's TRIGGER_JS call returns null (no Start-a-post button);
        //        the secondary probeFeedComposerLive inside surfaceLooksComposerCapable also returns
        //        present:false; → surfaceLooksComposerCapable returns false.
        //        The runtime returns surface_not_composer_capable BEFORE the MAIN entry probe
        //        (the probe that drives the fast-path) is even called.
        // When:  publishApprovedFeedPost is invoked.
        // Then:  result.reason==="surface_not_composer_capable"; result.dispatchAttempted===false;
        //        result.fallbackAllowed===true; dispatchClickLog.length===0.
        //        CRITICALLY (F-2 fix): probeEvaluateCallCount.n === 1 — exactly one PROBE_JS
        //        evaluate ran (the secondary probe inside the surface check), which proves the
        //        main entry probe / fast-path never ran. This distinguishes "only surface probe"
        //        from "surface probe + main entry probe" (the latter would be count=2).
        //        Also: closeEvaluateCallCount.n===0, focusEvaluateCallCount.n===0,
        //        clearEvaluateCallCount.n===0, insertTextLog.length===0.
        //        Pins the call order: surface check → entry probe → fast-path branch (F-2).
        // Covers SC-6 (surface check unaffected by fast-path).
        const constants = await loadPayloadConstants();
        const draftText = "FastPath.6 — surface not capable";
        const setup = await seedDraft("fp6-nocapable", draftText);

        const dispatchClickLog: Array<{ x: number; y: number }> = [];
        const pressKeyLog: string[] = [];
        const insertTextLog: Array<{ text: string }> = [];
        const closeEvaluateCallCount = { n: 0 };
        const triggerEvaluateCallCount = { n: 0 };
        const clearEvaluateCallCount = { n: 0 };
        const focusEvaluateCallCount = { n: 0 };
        // F-2: probe counter — proves only the surface-check's secondary probe ran,
        // not the main entry probe that feeds the fast-path gate.
        const probeEvaluateCallCount = { n: 0 };

        const clientOpts: P10FakeClientOpts = {
          constants,
          // surface-check TRIGGER_JS → null (not capable)
          surfaceCheckQueue: [null],
          // secondary probe in surfaceLooksComposerCapable → also absent (present:false)
          // This is the ONE probe call we expect. No further probe calls should occur
          // because the surface check short-circuits before the main entry probe.
          probeQueue: [
            { present: false, editorText: "" },
          ],
          triggerQueue: [],
          closeCenterQueue: [],
          discardCenterQueue: [],
          focusResult: false,
          clearResult: false,
          enabledQueue: [],
          postCenterResult: null,
          pressKeyLog,
          dispatchClickLog,
          insertTextLog,
          closeEvaluateCallCount,
          triggerEvaluateCallCount,
          clearEvaluateCallCount,
          focusEvaluateCallCount,
          probeEvaluateCallCount,
        };
        const client = makeFakeP10Client(clientOpts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail("TODO P10: publishApprovedFeedPost not exported (Step 4 pending)");
        }
        const result = await fn(deps);

        // T-FastPath.6 (F-2 corrected): surface check must short-circuit before the main entry probe.
        assert.equal(result.reason, "surface_not_composer_capable",
          "T-FastPath.6: reason must be surface_not_composer_capable");
        assert.equal(result.dispatchAttempted, false,
          "T-FastPath.6: dispatchAttempted must be false (no dispatch before surface fails)");
        assert.equal(result.fallbackAllowed, true,
          "T-FastPath.6: fallbackAllowed must be true");
        assert.equal(result.published, false, "T-FastPath.6: published must be false");
        assert.equal(dispatchClickLog.length, 0,
          "T-FastPath.6: no Post-button click must have been dispatched");
        // F-2 pin: exactly ONE probe call ran — the secondary probe inside surfaceLooksComposerCapable.
        // If the main entry probe (that drives the fast-path) also ran, count would be 2+.
        assert.equal(probeEvaluateCallCount.n, 1,
          `T-FastPath.6 (F-2): probeEvaluateCallCount must be exactly 1 (only the surface-check secondary probe). ` +
          `Got ${probeEvaluateCallCount.n}. A count >1 means the main entry probe ran (surface check did NOT short-circuit).`);
        // No focus/close/clear/insert must have run.
        assert.equal(closeEvaluateCallCount.n, 0, "T-FastPath.6: closeFeedComposerLive must NOT be called");
        assert.equal(focusEvaluateCallCount.n, 0, "T-FastPath.6: focusFeedComposerEditorLive must NOT be called");
        assert.equal(clearEvaluateCallCount.n, 0, "T-FastPath.6: clearFeedComposerEditorLive must NOT be called");
        assert.equal(insertTextLog.length, 0, "T-FastPath.6: insertTextHumanLike must NOT be called");
      },
    );
  },
);

// ---------------------------------------------------------------------------
// T-FastPath.7 — long-draft (>1000 chars) with 200-char prefix in composer → fast-path does NOT fire
// F-1 BLOCKER resolution: composerTextExact must NOT accept a prefix-only match for long drafts.
// This test FAILS on HEAD in two ways:
//   1. composerTextExact does not exist (RED because the entry gate cannot be exercised).
//   2. Even if the gate could be tested, the plan says composerAlreadyValid===false for this
//      case → flow goes to P9 close+reopen path (closeFeedComposerLive IS called).
// After Step 4: composerTextExact exists; the test asserts the P9 path is taken (not the fast-path),
// insertTextHumanLike is called with the FULL draft.text (length 1500, not 200 chars).
// ---------------------------------------------------------------------------

describe(
  "publishApprovedFeedPost — TARGET 1 fast-path: long-draft (>1000 chars) with 200-char prefix in composer → composerAlreadyValid===false → P9 close+reopen+insert path (T-FastPath.7, SC-2, F-1 pin)",
  () => {
    it(
      "T-FastPath.7: when draft.text.length===1500 and entry probe editorText===draft.text.slice(0,200) (exact F-1 failure case), composerAlreadyValid===false; closeFeedComposerLive IS called; insertTextHumanLike IS called with FULL 1500-char draft; Post-click is NOT dispatched BEFORE insertTextHumanLike",
      { timeout: 10000 },
      async () => {
        // Given: draft.text is "A".repeat(1500) (length 1500 — above the >1000-char prefix-tolerance
        //        threshold in composerTextMatches); entry probe editorText === draft.text.slice(0,200)
        //        (200 "A"s — exactly the case that OLD composerTextMatches would accept as prefix-match).
        //        Under composerTextExact: normForCompare("A".repeat(1500)) !== normForCompare("A".repeat(200))
        //        → composerAlreadyValid === false.
        //        After close succeeds: post-open probe returns present with empty text → clear+insert follows.
        //        Insert is scripted with the full 1500-char draft text → readback matches → post-button
        //        enabled → coords → Post-click fires AFTER insertTextHumanLike (the critical ordering).
        // When:  publishApprovedFeedPost is invoked.
        // Then:  closeFeedComposerLive IS called (closeEvaluateCallCount.n > 0) — fast-path NOT taken;
        //        triggerStartAPostLive IS called (triggerEvaluateCallCount.n > 0) — open-retry runs;
        //        insertTextHumanLike IS called with the FULL 1500-char draft (insertTextLog contains
        //        text of length 1500, NOT 200);
        //        dispatchClickLog.length === 1 (Post-button click after successful insert+readback);
        //        result.published === true (end-to-end success through the P9 path).
        //        The fast-path MUST NOT dispatch a Post-click on the 200-char prefix text.
        //        This directly pins F-1: the truncated-publish failure cannot occur.
        // Covers SC-2 (stale-text fallback to P9 path) + F-1 BLOCKER resolution.
        const constants = await loadPayloadConstants();
        const draftText = "A".repeat(1500); // length 1500, above the >1000 prefix-tolerance threshold
        const prefixText = "A".repeat(200);   // exactly the F-1 failure case: first 200 chars
        const setup = await seedDraft("fp7-longdraft-prefix", draftText);

        const dispatchClickLog: Array<{ x: number; y: number }> = [];
        const pressKeyLog: string[] = [];
        const insertTextLog: Array<{ text: string }> = [];
        const closeEvaluateCallCount = { n: 0 };
        const triggerEvaluateCallCount = { n: 0 };
        const clearEvaluateCallCount = { n: 0 };
        const focusEvaluateCallCount = { n: 0 };
        const probeEvaluateCallCount = { n: 0 };

        const clientOpts: P10FakeClientOpts = {
          constants,
          surfaceCheckQueue: [{ cx: 100, cy: 200 }],
          // Entry probe: present BUT editorText is ONLY the 200-char prefix → composerAlreadyValid=false
          // → P9 close+reopen path.
          // After close (close probes: present → absent):
          //   2 internal close probes (present → present → absent).
          // After trigger: post-open probe present with empty text.
          // After insert: readback matches full draftText.
          // Post-click: composer gone.
          probeQueue: [
            { present: true, editorText: prefixText },  // [0] entry probe: prefix-only → NOT fast-path
            { present: true, editorText: prefixText },  // [1] close internal probe 1: still present
            { present: false, editorText: "" },          // [2] close internal probe 2: closed
            { present: true, editorText: "" },           // [3] post-open probe: present (empty)
            { present: true, editorText: draftText },   // [4] readback: matches full draft
            { present: false, editorText: "" },          // [5] post-click: gone
          ],
          closeCenterQueue: [{ cx: 50, cy: 50 }],   // close-center found → click → closed
          discardCenterQueue: [null],
          triggerQueue: [{ cx: 100, cy: 200 }],     // trigger succeeds round 1
          focusResult: true,
          clearResult: true,
          enabledQueue: [true],
          postCenterResult: { cx: 480, cy: 320 },
          pressKeyLog,
          dispatchClickLog,
          insertTextLog,
          closeEvaluateCallCount,
          triggerEvaluateCallCount,
          clearEvaluateCallCount,
          focusEvaluateCallCount,
          probeEvaluateCallCount,
        };
        const client = makeFakeP10Client(clientOpts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail("TODO P10: publishApprovedFeedPost not exported (Step 4 pending)");
        }
        const result = await fn(deps);

        // T-FastPath.7: long-draft with 200-char prefix → composerAlreadyValid===false → P9 path.
        // The fast-path MUST NOT fire for this input. All P9 operations must be called.
        // Crucially: insertTextHumanLike must be called with the FULL 1500-char draft, not the prefix.
        //
        // ADJUSTMENT (plan §5 T-FastPath.7 per-char-insert note): insertTextHumanLike inserts
        // per-character (one Input.insertText per character). So insertTextLog has 1500 entries,
        // NOT one entry with a 1500-char string. The F-1 safety proof is that the concatenation
        // of all insertTextLog entries equals the full draftText (1500 "A"s), NOT the 200-char prefix.
        assert.ok(closeEvaluateCallCount.n > 0,
          `T-FastPath.7: closeFeedComposerLive must be called (P9 path taken, not fast-path). closeCount=${closeEvaluateCallCount.n}`);
        assert.ok(triggerEvaluateCallCount.n > 0,
          `T-FastPath.7: triggerStartAPostLive must be called (open-retry runs). triggerCount=${triggerEvaluateCallCount.n}`);
        // Per-char insert assertion: concatenation of all entries must equal the FULL 1500-char draft.
        const insertedFull = insertTextLog.map((e) => e.text).join("");
        assert.ok(insertTextLog.length > 0,
          "T-FastPath.7: insertTextHumanLike must be called (insertTextLog must not be empty)");
        assert.equal(insertedFull.length, draftText.length,
          `T-FastPath.7 (F-1 pin): total inserted char count must be ${draftText.length} (the full 1500-char draft), ` +
          `NOT the 200-char prefix. Got ${insertedFull.length} chars. ` +
          `(insertTextLog has ${insertTextLog.length} entries — per-char insert)`);
        assert.equal(insertedFull, draftText,
          "T-FastPath.7 (F-1 pin): concatenation of all insertTextLog entries must equal the full draft.text");
        // Post-click must fire AFTER the full insert (dispatchClickLog captures it).
        // Note: dispatchClickLog captures ALL dispatchHumanLikeClickAtCoords calls including
        // close-center (50,50) and trigger-center (100,200) and post-button (480,320).
        // Assert the Post-button click coords ARE in the log (proving it fired after insert).
        const postCenterCoords = { x: 480, y: 320 };
        const postClickFired = dispatchClickLog.some(
          (c) => c.x === postCenterCoords.x && c.y === postCenterCoords.y,
        );
        assert.ok(postClickFired,
          `T-FastPath.7: Post-button click at coords (${postCenterCoords.x},${postCenterCoords.y}) must be in dispatchClickLog. ` +
          `dispatchClickLog=${JSON.stringify(dispatchClickLog)}`);
        // End-to-end success through P9 path.
        assert.equal(result.published, true, "T-FastPath.7: result.published must be true (P9 path succeeds end-to-end)");
      },
    );
  },
);

// ---------------------------------------------------------------------------
// T-FastPath.8 — medium-draft (<1000 chars) with prefix-only in composer → fast-path does NOT fire
// Defensive companion to T-FastPath.7: confirms composerTextExact behaves identically to
// composerTextMatches for sub-1000-char drafts (neither accepts a prefix-only match there).
// ---------------------------------------------------------------------------

describe(
  "publishApprovedFeedPost — TARGET 1 fast-path: medium-draft (<1000 chars) with partial text in composer → composerAlreadyValid===false → P9 path (T-FastPath.8, SC-2, F-1 defensive companion)",
  () => {
    it(
      "T-FastPath.8: when draft.text.length===500 and entry probe editorText===draft.text.slice(0,100) (partial match, sub-1000 chars), composerAlreadyValid===false; P9 close+reopen+insert path is taken; insertTextHumanLike called with FULL 500-char draft",
      { timeout: 10000 },
      async () => {
        // Given: draft.text is "B".repeat(500) (length 500 — BELOW the 1000-char prefix-tolerance
        //        threshold in composerTextMatches); entry probe editorText === "B".repeat(100).
        //        For sub-1000 char drafts, BOTH composerTextExact AND the old composerTextMatches
        //        return false for a prefix-only match (the prefix branch at composerReadiness.ts:125
        //        only fires when intended.length > 1000). So for this case, composerAlreadyValid===false
        //        under BOTH the old and new code — this confirms composerTextExact doesn't BREAK
        //        sub-1000-char behavior; it only diverges from composerTextMatches on the >1000-char case.
        // When:  publishApprovedFeedPost is invoked.
        // Then:  closeFeedComposerLive IS called; triggerStartAPostLive IS called;
        //        insertTextHumanLike IS called with the FULL 500-char draft (not 100-char prefix);
        //        result.published === true.
        //        This confirms the fast-path does NOT fire for partial-text cases, even sub-1000.
        // Covers SC-2 + defensive companion to T-FastPath.7.
        const constants = await loadPayloadConstants();
        const draftText = "B".repeat(500);  // length 500, below the >1000 threshold
        const partialText = "B".repeat(100); // 100-char prefix
        const setup = await seedDraft("fp8-mediumdraft-prefix", draftText);

        const dispatchClickLog: Array<{ x: number; y: number }> = [];
        const pressKeyLog: string[] = [];
        const insertTextLog: Array<{ text: string }> = [];
        const closeEvaluateCallCount = { n: 0 };
        const triggerEvaluateCallCount = { n: 0 };
        const clearEvaluateCallCount = { n: 0 };
        const focusEvaluateCallCount = { n: 0 };
        const probeEvaluateCallCount = { n: 0 };

        const clientOpts: P10FakeClientOpts = {
          constants,
          surfaceCheckQueue: [{ cx: 100, cy: 200 }],
          probeQueue: [
            { present: true, editorText: partialText },  // [0] entry probe: partial-only → NOT fast-path
            { present: true, editorText: partialText },  // [1] close internal probe 1: still present
            { present: false, editorText: "" },           // [2] close internal probe 2: closed
            { present: true, editorText: "" },            // [3] post-open probe: present (empty)
            { present: true, editorText: draftText },    // [4] readback: matches full draft
            { present: false, editorText: "" },           // [5] post-click: gone
          ],
          closeCenterQueue: [{ cx: 50, cy: 50 }],
          discardCenterQueue: [null],
          triggerQueue: [{ cx: 100, cy: 200 }],
          focusResult: true,
          clearResult: true,
          enabledQueue: [true],
          postCenterResult: { cx: 480, cy: 320 },
          pressKeyLog,
          dispatchClickLog,
          insertTextLog,
          closeEvaluateCallCount,
          triggerEvaluateCallCount,
          clearEvaluateCallCount,
          focusEvaluateCallCount,
          probeEvaluateCallCount,
        };
        const client = makeFakeP10Client(clientOpts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail("TODO P10: publishApprovedFeedPost not exported (Step 4 pending)");
        }
        const result = await fn(deps);

        // T-FastPath.8: medium-draft (sub-1000 chars) with partial text → P9 path, not fast-path.
        // Per-char insert: concatenation of all insertTextLog entries must equal the FULL 500-char draft.
        assert.ok(closeEvaluateCallCount.n > 0,
          `T-FastPath.8: closeFeedComposerLive must be called (P9 path taken, not fast-path). closeCount=${closeEvaluateCallCount.n}`);
        assert.ok(triggerEvaluateCallCount.n > 0,
          `T-FastPath.8: triggerStartAPostLive must be called (open-retry runs). triggerCount=${triggerEvaluateCallCount.n}`);
        // Per-char insert assertion: concatenation of all entries must equal the FULL 500-char draft.
        const insertedMedium = insertTextLog.map((e) => e.text).join("");
        assert.ok(insertTextLog.length > 0,
          "T-FastPath.8: insertTextHumanLike must be called (insertTextLog must not be empty)");
        assert.equal(insertedMedium.length, draftText.length,
          `T-FastPath.8: total inserted char count must be ${draftText.length} (full 500-char draft), ` +
          `NOT the 100-char partial. Got ${insertedMedium.length} chars.`);
        assert.equal(insertedMedium, draftText,
          "T-FastPath.8: concatenation of all insertTextLog entries must equal the full draft.text");
        // dispatchClickLog captures ALL dispatchHumanLikeClickAtCoords calls (close, trigger, post).
        // Assert the Post-button click coords ARE in the log (proving it fired after insert).
        const postCenterCoordsM = { x: 480, y: 320 };
        const postClickFiredM = dispatchClickLog.some(
          (c) => c.x === postCenterCoordsM.x && c.y === postCenterCoordsM.y,
        );
        assert.ok(postClickFiredM,
          `T-FastPath.8: Post-button click at coords (${postCenterCoordsM.x},${postCenterCoordsM.y}) must be in dispatchClickLog. ` +
          `dispatchClickLog=${JSON.stringify(dispatchClickLog)}`);
        assert.equal(result.published, true, "T-FastPath.8: result.published must be true (P9 path succeeds end-to-end)");
      },
    );
  },
);
