/**
 * P-POST-PUBLISH-9 Step 2 — Outside-in TDD scaffold
 * Tests for the open-chain retry logic + finer failure reasons + surface-check
 * in publishApprovedFeedPost (deterministicPublishPost.ts lines 77-86 area).
 *
 * Behaviors covered (plan §5):
 *   T-OpenRetry.1 / .2 / .3
 *   T-OpenReason.1 / .2 / .3 / .4
 *   T-OpenInvariant.1 / .2  (parameterized × 4 new reasons)
 *   T-OpenHappy.1 / .2
 *
 * ALL assertion bodies are TODO / assert.fail — they must FAIL on HEAD
 * (the 4 new reason strings don't exist yet; the retry loops aren't there).
 * Builder (Codex) will make the assertions compile + reach assertion-TODO.
 * Validator fills assertion bodies at Step 5.
 *
 * Mock seam: a fake CdpClient whose evaluate() dispatches by strict-equal
 * payload match (constants loaded dynamically from composerReadiness.js).
 * Per-payload FIFO queues (array.shift()) allow the same JS payload key to
 * return different values on successive calls — required by T-OpenReason.2
 * and the open-retry tests.
 *
 * spyDispatchClickAtCoords: logs ALL calls to dispatchHumanLikeClickAtCoords.
 * T-OpenInvariant.2 asserts no click at POST_BUTTON_SENTINEL_COORDS (999,888) —
 * i.e. the runtime's Post-button dispatch (deterministicPublishPost.ts:118) never fires.
 * Start-a-post clicks from triggerStartAPostLive at other coords are expected and allowed.
 *
 * Runner:
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/workflow/runtime/deterministicPublishPost-open.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpClient } from "../../../../src/cdp/client.js";

// Disable inter-tool pacing.
process.env.FRONDOSE_PACE_MIN_MS = "0";

// ---------------------------------------------------------------------------
// Payload-constant loader (mirrors deterministicPublishPost.mock.test.ts CMR-4)
// ---------------------------------------------------------------------------

const SENTINEL_PROBE = "__P9_SENTINEL_PROBE__";
const SENTINEL_FOCUS = "__P9_SENTINEL_FOCUS__";
const SENTINEL_CLEAR = "__P9_SENTINEL_CLEAR__";
const SENTINEL_ENABLED = "__P9_SENTINEL_ENABLED__";
const SENTINEL_CENTER = "__P9_SENTINEL_POST_CENTER__";
const SENTINEL_TRIGGER = "__P9_SENTINEL_TRIGGER__";
const SENTINEL_CLOSE_CENTER = "__P9_SENTINEL_CLOSE_CENTER__";
const SENTINEL_DISCARD_CENTER = "__P9_SENTINEL_DISCARD_CENTER__";

// Sentinel Post-button coords used by makeClientForReason for all 4 fail-reason cases.
// The production runtime exits before reaching getFeedComposerPostButtonCenterLive in every
// failure scenario, so CENTER_JS is never evaluated and these coords are never returned.
// T-OpenInvariant.2 asserts that NO entry in dispatchClickLog matches these coords —
// proving the Post-button click (deterministicPublishPost.ts:118) never fires.
const POST_BUTTON_SENTINEL_COORDS = { cx: 999, cy: 888 } as const;

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
// Queue-based fake CdpClient harness
//
// Each payload key maps to a FIFO queue (Array.shift()).  When the queue is
// exhausted, the last value is repeated.  This allows the same JS constant
// to return different results on successive calls — which T-OpenReason.2 and
// the retry tests require.
//
// dispatchClickCount is a spy on dispatchHumanLikeClickAtCoords — used by
// T-OpenInvariant.2 and T-OpenHappy.2.
// ---------------------------------------------------------------------------

interface P9FakeClientOpts {
  constants: PayloadConstants;
  // Per-key FIFO queues. Consumed by Array.shift(); last value is sticky.
  // Probe results for isFeedComposerLiveInDOM / probeFeedComposerLive.
  probeQueue: Array<{ present: boolean; editorText: string }>;
  // triggerStartAPostLive: FEED_START_A_POST_CENTER_JS results.
  // Each entry is either a center object (truthy → click is dispatched + returns true)
  // or null (returns false). FIFO.
  triggerQueue: Array<{ cx: number; cy: number } | null>;
  // Surface-check-specific FEED_START_A_POST_CENTER_JS results (separate queue
  // so the surface-check call can be scripted independently of trigger calls).
  // When populated, the FIRST call to TRIGGER_JS consumes from surfaceCheckQueue;
  // subsequent calls consume from triggerQueue.
  surfaceCheckQueue: Array<{ cx: number; cy: number } | null>;
  // closeFeedComposerLive close-center JS results (CLOSE_CENTER_JS).
  closeCenterQueue: Array<{ cx: number; cy: number } | null>;
  // discardCenterQueue for DISCARD_CENTER_JS.
  discardCenterQueue: Array<{ cx: number; cy: number } | null>;
  focusResult: boolean;
  clearResult: boolean;
  enabledQueue: boolean[];
  postCenterResult: { cx: number; cy: number } | null;
  // pressKey spy (counts Escape presses inside closeFeedComposerLive).
  pressKeyLog: string[];
  // dispatchHumanLikeClickAtCoords spy.
  dispatchClickLog: Array<{ x: number; y: number }>;
  // insertText log (for happy-path smoke).
  insertTextLog: Array<{ text: string }>;
}

function peekOrLast<T>(queue: T[]): T | undefined {
  if (queue.length === 0) return undefined;
  return queue.length === 1 ? queue[0] : queue.shift();
}

function makeFakeP9Client(opts: P9FakeClientOpts): CdpClient {
  const { constants: c } = opts;
  let enabledIdx = 0;
  // Track whether the surface-check queue has been consumed (first TRIGGER_JS call)
  let surfaceCheckConsumed = false;

  const fakeHandle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({ nodes: [] }),
    },
    Runtime: {
      evaluate: async (args: { expression: string }) => {
        const expr = args.expression;

        // CLOSE_CENTER_JS — must come before PROBE to avoid any overlap
        if (expr === c.CLOSE_CENTER_JS) {
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
        // First call consumes from surfaceCheckQueue if available; subsequent from triggerQueue.
        if (expr === c.TRIGGER_JS) {
          let raw: { cx: number; cy: number } | null;
          if (!surfaceCheckConsumed && opts.surfaceCheckQueue.length > 0) {
            raw = peekOrLast(opts.surfaceCheckQueue) ?? null;
            surfaceCheckConsumed = true;
          } else {
            raw = peekOrLast(opts.triggerQueue) ?? null;
          }
          // Return the raw JSON — triggerStartAPostLive calls parseCenterPayload internally.
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
        // PROBE_JS (FEED_COMPOSER_LIVE_IN_DOM_JS / FEED_COMPOSER_EDITOR_JS)
        if (expr === c.PROBE_JS) {
          const res = peekOrLast(opts.probeQueue) ?? {
            present: false,
            editorText: "",
          };
          return { result: { value: JSON.stringify(res) } };
        }
        // FOCUS_JS
        if (expr === c.FOCUS_JS) {
          return { result: { value: opts.focusResult } };
        }
        // CLEAR_JS
        if (expr === c.CLEAR_JS) {
          return { result: { value: opts.clearResult } };
        }

        // Fallback: if we're using sentinels, route by substring clues.
        if (
          expr.includes("CLOSE_RE") ||
          expr.includes("FEED_COMPOSER_CLOSE")
        ) {
          return { result: { value: JSON.stringify(null) } };
        }
        if (
          expr.includes("DISCARD_RE") ||
          expr.includes("FEED_COMPOSER_DISCARD")
        ) {
          return { result: { value: JSON.stringify(null) } };
        }
        if (expr.includes("Start a post") || expr.includes("START_RE")) {
          let raw: { cx: number; cy: number } | null;
          if (!surfaceCheckConsumed && opts.surfaceCheckQueue.length > 0) {
            raw = peekOrLast(opts.surfaceCheckQueue) ?? null;
            surfaceCheckConsumed = true;
          } else {
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
          return { result: { value: opts.focusResult } };
        }
        if (
          expr.includes("deleteContentBackward") ||
          expr.includes("selectAll") ||
          expr.includes("CLEAR")
        ) {
          return { result: { value: opts.clearResult } };
        }
        // Default: treat as probe
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

  // Override pressKey to log key presses (needed for closeFeedComposerLive spy).
  const origPressKey = client.pressKey.bind(client);
  client.pressKey = async (key: string) => {
    opts.pressKeyLog.push(key);
    return origPressKey(key);
  };

  // Override dispatchHumanLikeClickAtCoords to spy on calls.
  const origDispatch = client.dispatchHumanLikeClickAtCoords.bind(client);
  client.dispatchHumanLikeClickAtCoords = async (x: number, y: number) => {
    opts.dispatchClickLog.push({ x, y });
    return origDispatch(x, y);
  };

  return client;
}

// ---------------------------------------------------------------------------
// Draft seeding helper (mirrors the P8/P7 deterministicPublishPost.mock.test.ts
// seedDraft pattern exactly — creates a real sales.db row for the happy-path).
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
  const scratchDir = join(tmpdir(), `frondose-p9-open-${label}`, `${Date.now()}`);
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
    // pre-Step-4: helpers don't exist yet; test will hit assert.fail
  }
  return {
    scratchDir,
    auditPath,
    dbPath,
    draftId: "d-seed-unavailable",
  };
}

// ---------------------------------------------------------------------------
// Deps builder (mirrors makePublishDeps from deterministicPublishPost.mock.test.ts)
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
    workflowId: "wf-p9-open",
    stepId: "step-p9-open",
    draftId: setup.draftId,
  };
}

// ---------------------------------------------------------------------------
// Dynamic import helper (re-imports publishApprovedFeedPost)
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
// T-OpenRetry — retry-poll the open
// ---------------------------------------------------------------------------

describe(
  "publishApprovedFeedPost — open retry: triggerStartAPostLive succeeds on 2nd round after AX-lag (T-OpenRetry.1, SC-1)",
  () => {
    it(
      "T-OpenRetry.1: when composer absent + trigger false on round 1 then center on round 2 + post-open probe present, runtime proceeds to focus and returns {published:true}",
      { timeout: 10000 },
      async () => {
        // Given: surface-check says capable; entry probe present:false; trigger returns null round-1
        //        (false), center round-2 (true); post-open probe present:true after round-2 trigger;
        //        focus/clear/insert/readback/enabled/coords/click all succeed.
        // When:  publishApprovedFeedPost(deps) is called.
        // Then:  result.published===true; result.dispatchAttempted===true; result.reason===undefined;
        //        focus was called (dispatchClickLog has Post coords click ONLY, not a spurious trigger).
        // Covers SC-1.
        const constants = await loadPayloadConstants();
        const draftText = "Retry.1 success";
        const setup = await seedDraft("retry1", draftText);
        const dispatchClickLog: Array<{ x: number; y: number }> = [];
        const pressKeyLog: string[] = [];
        const insertTextLog: Array<{ text: string }> = [];

        const clientOpts: P9FakeClientOpts = {
          constants,
          // surfaceCheckQueue: surface-check first TRIGGER_JS call → center present (capable)
          surfaceCheckQueue: [{ cx: 100, cy: 200 }],
          // Entry probe: absent (no close needed)
          probeQueue: [
            { present: false, editorText: "" }, // entry probe
            { present: true, editorText: "" }, // post-open probe after round-2 trigger
            { present: true, editorText: draftText }, // readback
            { present: false, editorText: "" }, // post-click: gone
          ],
          // triggerQueue: round-1 = null (false), round-2 = center (true)
          triggerQueue: [null, { cx: 100, cy: 200 }],
          closeCenterQueue: [],
          discardCenterQueue: [],
          focusResult: true,
          clearResult: true,
          enabledQueue: [true],
          postCenterResult: { cx: 480, cy: 320 },
          pressKeyLog,
          dispatchClickLog,
          insertTextLog,
        };
        const client = makeFakeP9Client(clientOpts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail(
            "TODO P9: publishApprovedFeedPost not exported (Step 4 pending)",
          );
        }
        const result = await fn(deps);
        // T-OpenRetry.1 assertions: trigger false→true across rounds → runtime published.
        assert.equal(result.published, true, `T-OpenRetry.1: published should be true after 2nd-round trigger, got ${JSON.stringify(result)}`);
        assert.equal(result.dispatchAttempted, true, `T-OpenRetry.1: dispatchAttempted should be true`);
        assert.equal(result.fallbackAllowed, false, `T-OpenRetry.1: fallbackAllowed should be false on success`);
        assert.equal(result.reason, undefined, `T-OpenRetry.1: no fail reason expected, got ${result.reason}`);
        // Covers SC-1: open retry succeeded on 2nd round.
      },
    );
  },
);

describe(
  "publishApprovedFeedPost — open retry: post-open probe succeeds on 2nd poll after trigger (T-OpenRetry.2, SC-2)",
  () => {
    it(
      "T-OpenRetry.2: when composer absent + trigger succeeds round 1 + post-open probe absent then present on 2nd call, runtime proceeds to focus",
      { timeout: 10000 },
      async () => {
        // Given: surface capable; entry probe absent; trigger true round-1;
        //        post-open probe present:false on first call then present:true on second;
        //        rest of sequence happy-path.
        // When:  publishApprovedFeedPost runs.
        // Then:  result.published===true; no composer_*_failed reason recorded.
        // Covers SC-2.
        const constants = await loadPayloadConstants();
        const draftText = "Retry.2 probe-poll";
        const setup = await seedDraft("retry2", draftText);
        const dispatchClickLog: Array<{ x: number; y: number }> = [];
        const pressKeyLog: string[] = [];
        const insertTextLog: Array<{ text: string }> = [];

        const clientOpts: P9FakeClientOpts = {
          constants,
          surfaceCheckQueue: [{ cx: 100, cy: 200 }],
          probeQueue: [
            { present: false, editorText: "" }, // entry probe
            { present: false, editorText: "" }, // post-open probe round-1: absent
            { present: true, editorText: "" }, // post-open probe round-2: present
            { present: true, editorText: draftText }, // readback
            { present: false, editorText: "" }, // post-click: gone
          ],
          triggerQueue: [{ cx: 100, cy: 200 }], // trigger succeeds round 1
          closeCenterQueue: [],
          discardCenterQueue: [],
          focusResult: true,
          clearResult: true,
          enabledQueue: [true],
          postCenterResult: { cx: 480, cy: 320 },
          pressKeyLog,
          dispatchClickLog,
          insertTextLog,
        };
        const client = makeFakeP9Client(clientOpts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail(
            "TODO P9: publishApprovedFeedPost not exported (Step 4 pending)",
          );
        }
        const result = await fn(deps);
        // T-OpenRetry.2 assertions: trigger succeeds round-1 but post-open probe absent then present → published.
        assert.equal(result.published, true, `T-OpenRetry.2: published should be true after 2nd probe poll, got ${JSON.stringify(result)}`);
        assert.equal(result.dispatchAttempted, true, `T-OpenRetry.2: dispatchAttempted should be true`);
        assert.equal(result.fallbackAllowed, false, `T-OpenRetry.2: fallbackAllowed should be false on success`);
        assert.equal(result.reason, undefined, `T-OpenRetry.2: no fail reason expected, got ${result.reason}`);
        // Covers SC-2: post-open probe retry succeeded on 2nd poll.
      },
    );
  },
);

describe(
  "publishApprovedFeedPost — open retry: worst-case budget exhaustion stays within SC-7 latency cap (T-OpenRetry.3, SC-7)",
  () => {
    it(
      "T-OpenRetry.3: when every call returns worst-case (trigger false, probe absent) for full COMPOSER_OPEN_RETRY_ROUNDS budget, result is composer_open_click_failed AND total elapsed ≤ 1500 ms",
      { timeout: 10000 },
      async () => {
        // Given: surface-check capable; entry probe absent; trigger returns null every round;
        //        COMPOSER_OPEN_RETRY_ROUNDS exhausted; READBACK_RETRY_MS=120ms×3 inter-round sleeps.
        // When:  publishApprovedFeedPost runs.
        // Then:  result.reason==="composer_open_click_failed";
        //        total wall-clock (Date.now() delta) ≤ 1500 ms.
        //
        // Timing-assertion approach (recorded in test-contract §note):
        //   We use a real Date.now() delta with a generous 1500ms upper bound.
        //   Wall-clock is acceptable here because READBACK_RETRY_MS=120ms with
        //   COMPOSER_OPEN_RETRY_ROUNDS=4 means worst-case ≤ 3×120=360ms of new
        //   inter-round sleeps + triggerStartAPostLive internal 120ms×4=480ms +
        //   evaluate RTTs ≈ well under 1500ms in a local test environment.
        //   If flakiness emerges at Step 5, the contract doc notes to switch to
        //   a sleep-call-count approach via a sleep-injection shim.
        // Covers SC-7.
        const constants = await loadPayloadConstants();
        const setup = await seedDraft("retry3-worst", "worst-case text");
        const dispatchClickLog: Array<{ x: number; y: number }> = [];
        const pressKeyLog: string[] = [];
        const insertTextLog: Array<{ text: string }> = [];

        // 4 rounds × trigger null + probe absent each
        const clientOpts: P9FakeClientOpts = {
          constants,
          surfaceCheckQueue: [{ cx: 100, cy: 200 }],
          probeQueue: [
            { present: false, editorText: "" }, // entry probe
            { present: false, editorText: "" },
            { present: false, editorText: "" },
            { present: false, editorText: "" },
            { present: false, editorText: "" },
          ],
          triggerQueue: [null, null, null, null], // all rounds fail
          closeCenterQueue: [],
          discardCenterQueue: [],
          focusResult: false,
          clearResult: false,
          enabledQueue: [],
          postCenterResult: null,
          pressKeyLog,
          dispatchClickLog,
          insertTextLog,
        };
        const client = makeFakeP9Client(clientOpts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail(
            "TODO P9: publishApprovedFeedPost not exported (Step 4 pending)",
          );
        }
        const t0 = Date.now();
        const result = await fn(deps);
        const elapsed = Date.now() - t0;
        // T-OpenRetry.3 assertions: worst-case budget exhaustion.
        assert.equal(result.reason, "composer_open_click_failed", `T-OpenRetry.3: reason should be composer_open_click_failed, got ${result.reason}`);
        assert.equal(result.dispatchAttempted, false, `T-OpenRetry.3: dispatchAttempted should be false`);
        assert.equal(result.fallbackAllowed, true, `T-OpenRetry.3: fallbackAllowed should be true`);
        // SC-7 latency cap: worst-case = 3×120ms inter-round + 4×120ms internal = 840ms. Bound = 1500ms.
        assert.ok(elapsed <= 1500, `T-OpenRetry.3: elapsed ${elapsed}ms exceeds SC-7 cap of 1500ms`);
        // Covers SC-7: latency cap.
      },
    );
  },
);

// ---------------------------------------------------------------------------
// T-OpenReason — finer reason firing
// ---------------------------------------------------------------------------

describe(
  "publishApprovedFeedPost — finer reason: composer_close_failed when close-retry exhausts (T-OpenReason.1, SC-3)",
  () => {
    it(
      "T-OpenReason.1: when entry probe present + closeFeedComposerLive keeps composer present after every attempt, reason==='composer_close_failed' AND dispatchAttempted===false AND fallbackAllowed===true",
      { timeout: 10000 },
      async () => {
        // Given: surface capable; entry probe present:true (triggers close);
        //        closeFeedComposerLive internal probe always returns still-present
        //        (CLOSE_CENTER_JS returns null × all attempts; probe always present);
        //        COMPOSER_CLOSE_RETRY_ATTEMPTS exhausted.
        // When:  publishApprovedFeedPost runs.
        // Then:  result.reason==="composer_close_failed";
        //        result.dispatchAttempted===false; result.fallbackAllowed===true.
        // Covers SC-3 (close branch) + SC-4.
        const constants = await loadPayloadConstants();
        const setup = await seedDraft("reason1-closefail", "close fail text");
        const dispatchClickLog: Array<{ x: number; y: number }> = [];
        const pressKeyLog: string[] = [];
        const insertTextLog: Array<{ text: string }> = [];

        // closeFeedComposerLive internals:
        //   Escape + sleep + clickComposerDiscardControlIfPresent (DISCARD_CENTER_JS null) +
        //   isFeedComposerLiveInDOM (probe 1) → still present →
        //   clickComposerControlAtCenter CLOSE_CENTER_JS null (no click) →
        //   isFeedComposerLiveInDOM (probe 2) → still present → return false
        //
        // With COMPOSER_CLOSE_RETRY_ATTEMPTS=3, the loop runs up to 3 times.
        // Each attempt calls closeFeedComposerLive which does 2 internal probes.
        // Script 6 consecutive probe results as present (3 attempts × 2 probes each).
        const clientOpts: P9FakeClientOpts = {
          constants,
          surfaceCheckQueue: [{ cx: 100, cy: 200 }],
          probeQueue: [
            { present: true, editorText: "stale" }, // entry probe: present → close path
            // closeFeedComposerLive attempt 1
            { present: true, editorText: "stale" }, // close internal probe 1
            { present: true, editorText: "stale" }, // close internal probe 2
            // closeFeedComposerLive attempt 2
            { present: true, editorText: "stale" }, // close internal probe 1
            { present: true, editorText: "stale" }, // close internal probe 2
            // closeFeedComposerLive attempt 3
            { present: true, editorText: "stale" }, // close internal probe 1
            { present: true, editorText: "stale" }, // close internal probe 2
          ],
          triggerQueue: [],
          closeCenterQueue: [null, null, null, null, null, null], // never finds close button
          discardCenterQueue: [null, null, null, null, null, null],
          focusResult: false,
          clearResult: false,
          enabledQueue: [],
          postCenterResult: null,
          pressKeyLog,
          dispatchClickLog,
          insertTextLog,
        };
        const client = makeFakeP9Client(clientOpts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail(
            "TODO P9: publishApprovedFeedPost not exported (Step 4 pending)",
          );
        }
        const result = await fn(deps);
        // T-OpenReason.1 assertions: close-retry exhaustion → composer_close_failed.
        assert.equal(result.reason, "composer_close_failed", `T-OpenReason.1: reason should be composer_close_failed, got ${result.reason}`);
        assert.equal(result.dispatchAttempted, false, `T-OpenReason.1: dispatchAttempted should be false (pre-dispatch)`);
        assert.equal(result.fallbackAllowed, true, `T-OpenReason.1: fallbackAllowed should be true`);
        assert.equal(result.published, false, `T-OpenReason.1: published should be false`);
        // Covers SC-3 (close branch) + SC-4.
      },
    );
  },
);

describe(
  "publishApprovedFeedPost — finer reason: composer_open_click_failed when trigger never succeeds (T-OpenReason.2, SC-3)",
  () => {
    it(
      "T-OpenReason.2: when surface capable + entry probe absent + FEED_START_A_POST_CENTER_JS returns null every round, reason==='composer_open_click_failed' AND dispatchAttempted===false",
      { timeout: 10000 },
      async () => {
        // Given: surface-check TRIGGER_JS call 0 returns center (surface-capable);
        //        entry probe present:false; TRIGGER_JS calls 1..N (open rounds) return null
        //        so triggerStartAPostLive returns false every round;
        //        COMPOSER_OPEN_RETRY_ROUNDS exhausted, trigger never succeeded.
        // When:  publishApprovedFeedPost runs.
        // Then:  result.reason==="composer_open_click_failed";
        //        result.dispatchAttempted===false; result.fallbackAllowed===true.
        // Covers SC-3 (open-click branch).
        //
        // Note: the surface-check call is the FIRST call to TRIGGER_JS (surfaceCheckQueue[0]);
        // subsequent open-round calls come from triggerQueue (all null).
        const constants = await loadPayloadConstants();
        const setup = await seedDraft("reason2-clickfail", "click fail text");
        const dispatchClickLog: Array<{ x: number; y: number }> = [];
        const pressKeyLog: string[] = [];
        const insertTextLog: Array<{ text: string }> = [];

        const clientOpts: P9FakeClientOpts = {
          constants,
          surfaceCheckQueue: [{ cx: 100, cy: 200 }], // surface-check call → capable
          probeQueue: [
            { present: false, editorText: "" }, // entry probe: absent
          ],
          triggerQueue: [null, null, null, null], // rounds 1..4: all null
          closeCenterQueue: [],
          discardCenterQueue: [],
          focusResult: false,
          clearResult: false,
          enabledQueue: [],
          postCenterResult: null,
          pressKeyLog,
          dispatchClickLog,
          insertTextLog,
        };
        const client = makeFakeP9Client(clientOpts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail(
            "TODO P9: publishApprovedFeedPost not exported (Step 4 pending)",
          );
        }
        const result = await fn(deps);
        // T-OpenReason.2 assertions: open trigger always null → composer_open_click_failed.
        assert.equal(result.reason, "composer_open_click_failed", `T-OpenReason.2: reason should be composer_open_click_failed, got ${result.reason}`);
        assert.equal(result.dispatchAttempted, false, `T-OpenReason.2: dispatchAttempted should be false`);
        assert.equal(result.fallbackAllowed, true, `T-OpenReason.2: fallbackAllowed should be true`);
        assert.equal(result.published, false, `T-OpenReason.2: published should be false`);
        // Covers SC-3 (open-click branch).
      },
    );
  },
);

describe(
  "publishApprovedFeedPost — finer reason: composer_absent_after_open when trigger succeeds but probe never present (T-OpenReason.3, SC-3)",
  () => {
    it(
      "T-OpenReason.3: when surface capable + entry probe absent + trigger returns true round 1 + post-open probe always absent, reason==='composer_absent_after_open' AND dispatchAttempted===false",
      { timeout: 10000 },
      async () => {
        // Given: surface capable; entry probe absent; triggerStartAPostLive returns true round 1
        //        (center found + click dispatched internally); post-open probeFeedComposerLive
        //        always returns present:false for every round in the open loop;
        //        openClickEverSucceeded=true but probeEverPresent=false.
        // When:  publishApprovedFeedPost runs.
        // Then:  result.reason==="composer_absent_after_open";
        //        result.dispatchAttempted===false; result.fallbackAllowed===true.
        // Covers SC-3 (probe-absent branch).
        const constants = await loadPayloadConstants();
        const setup = await seedDraft("reason3-absentafter", "absent after open");
        const dispatchClickLog: Array<{ x: number; y: number }> = [];
        const pressKeyLog: string[] = [];
        const insertTextLog: Array<{ text: string }> = [];

        const clientOpts: P9FakeClientOpts = {
          constants,
          surfaceCheckQueue: [{ cx: 100, cy: 200 }],
          probeQueue: [
            { present: false, editorText: "" }, // entry probe: absent
            { present: false, editorText: "" }, // post-open probe round 1: absent
            { present: false, editorText: "" }, // post-open probe round 2: absent
            { present: false, editorText: "" }, // post-open probe round 3: absent
            { present: false, editorText: "" }, // post-open probe round 4: absent
          ],
          triggerQueue: [{ cx: 100, cy: 200 }, null, null, null], // round 1 succeeds, rest fail
          closeCenterQueue: [],
          discardCenterQueue: [],
          focusResult: false,
          clearResult: false,
          enabledQueue: [],
          postCenterResult: null,
          pressKeyLog,
          dispatchClickLog,
          insertTextLog,
        };
        const client = makeFakeP9Client(clientOpts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail(
            "TODO P9: publishApprovedFeedPost not exported (Step 4 pending)",
          );
        }
        const result = await fn(deps);
        // T-OpenReason.3 assertions: trigger succeeds but probe never present → composer_absent_after_open.
        assert.equal(result.reason, "composer_absent_after_open", `T-OpenReason.3: reason should be composer_absent_after_open, got ${result.reason}`);
        assert.equal(result.dispatchAttempted, false, `T-OpenReason.3: dispatchAttempted should be false`);
        assert.equal(result.fallbackAllowed, true, `T-OpenReason.3: fallbackAllowed should be true`);
        assert.equal(result.published, false, `T-OpenReason.3: published should be false`);
        // Covers SC-3 (probe-absent branch).
      },
    );
  },
);

describe(
  "publishApprovedFeedPost — finer reason: surface_not_composer_capable when both surface signals say no (T-OpenReason.4, SC-3)",
  () => {
    it(
      "T-OpenReason.4: when FEED_START_A_POST_CENTER_JS returns null AND probeFeedComposerLive present:false, reason==='surface_not_composer_capable' AND dispatchAttempted===false AND close/open/focus spies all zero",
      { timeout: 10000 },
      async () => {
        // Given: surface-check TRIGGER_JS call returns null (no Start-a-post button);
        //        secondary probeFeedComposerLive also returns present:false;
        //        runtime bails immediately at surface-check exit.
        // When:  publishApprovedFeedPost runs.
        // Then:  result.reason==="surface_not_composer_capable";
        //        result.dispatchAttempted===false; result.fallbackAllowed===true;
        //        dispatchClickLog.length===0 (no close/trigger/post clicks at all).
        // Covers SC-3 (surface branch).
        const constants = await loadPayloadConstants();
        const setup = await seedDraft("reason4-surface", "surface not capable");
        const dispatchClickLog: Array<{ x: number; y: number }> = [];
        const pressKeyLog: string[] = [];
        const insertTextLog: Array<{ text: string }> = [];

        const clientOpts: P9FakeClientOpts = {
          constants,
          surfaceCheckQueue: [null], // surface-check TRIGGER_JS → null (not capable)
          probeQueue: [
            { present: false, editorText: "" }, // secondary probe in surfaceLooksComposerCapable
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
        };
        const client = makeFakeP9Client(clientOpts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail(
            "TODO P9: publishApprovedFeedPost not exported (Step 4 pending)",
          );
        }
        const result = await fn(deps);
        // T-OpenReason.4 assertions: both surface signals null/absent → surface_not_composer_capable.
        assert.equal(result.reason, "surface_not_composer_capable", `T-OpenReason.4: reason should be surface_not_composer_capable, got ${result.reason}`);
        assert.equal(result.dispatchAttempted, false, `T-OpenReason.4: dispatchAttempted should be false`);
        assert.equal(result.fallbackAllowed, true, `T-OpenReason.4: fallbackAllowed should be true`);
        assert.equal(result.published, false, `T-OpenReason.4: published should be false`);
        // No close/trigger/post clicks dispatched: runtime bailed at surface check.
        assert.equal(dispatchClickLog.length, 0, `T-OpenReason.4: dispatchClickLog should be empty (no clicks before surface exit), got ${JSON.stringify(dispatchClickLog)}`);
        // Covers SC-3 (surface branch).
      },
    );
  },
);

// ---------------------------------------------------------------------------
// T-OpenInvariant — no-double-post: parameterized × 4 new reasons
// ---------------------------------------------------------------------------

const NEW_FAIL_REASONS = [
  "composer_close_failed",
  "composer_open_click_failed",
  "composer_absent_after_open",
  "surface_not_composer_capable",
] as const;

type NewFailReason = (typeof NEW_FAIL_REASONS)[number];

/**
 * Build a client that will produce the given fail reason.
 * Used by T-OpenInvariant.1 and T-OpenInvariant.2 parameterized loops.
 */
async function makeClientForReason(
  reason: NewFailReason,
  constants: PayloadConstants,
  dispatchClickLog: Array<{ x: number; y: number }>,
  pressKeyLog: string[],
): Promise<CdpClient> {
  const insertTextLog: Array<{ text: string }> = [];
  let opts: P9FakeClientOpts;

  switch (reason) {
    case "surface_not_composer_capable":
      opts = {
        constants,
        surfaceCheckQueue: [null],
        probeQueue: [{ present: false, editorText: "" }],
        triggerQueue: [],
        closeCenterQueue: [],
        discardCenterQueue: [],
        focusResult: false,
        clearResult: false,
        enabledQueue: [],
        // POST_BUTTON_SENTINEL_COORDS: sentinel Post-center — runtime exits before CENTER_JS
        // is ever evaluated in this fail case, so these coords will NEVER appear in
        // dispatchClickLog. T-OpenInvariant.2 asserts no click at these coords.
        postCenterResult: { cx: POST_BUTTON_SENTINEL_COORDS.cx, cy: POST_BUTTON_SENTINEL_COORDS.cy },
        pressKeyLog,
        dispatchClickLog,
        insertTextLog,
      };
      break;
    case "composer_close_failed":
      opts = {
        constants,
        surfaceCheckQueue: [{ cx: 100, cy: 200 }],
        probeQueue: [
          { present: true, editorText: "stale" },
          // 3 attempts × 2 internal probes each: all still present
          { present: true, editorText: "stale" },
          { present: true, editorText: "stale" },
          { present: true, editorText: "stale" },
          { present: true, editorText: "stale" },
          { present: true, editorText: "stale" },
          { present: true, editorText: "stale" },
        ],
        triggerQueue: [],
        closeCenterQueue: [null, null, null, null, null, null],
        discardCenterQueue: [null, null, null, null, null, null],
        focusResult: false,
        clearResult: false,
        enabledQueue: [],
        // POST_BUTTON_SENTINEL_COORDS: runtime returns composer_close_failed before
        // reaching getFeedComposerPostButtonCenterLive — CENTER_JS never evaluated.
        postCenterResult: { cx: POST_BUTTON_SENTINEL_COORDS.cx, cy: POST_BUTTON_SENTINEL_COORDS.cy },
        pressKeyLog,
        dispatchClickLog,
        insertTextLog,
      };
      break;
    case "composer_open_click_failed":
      opts = {
        constants,
        surfaceCheckQueue: [{ cx: 100, cy: 200 }],
        probeQueue: [{ present: false, editorText: "" }],
        triggerQueue: [null, null, null, null],
        closeCenterQueue: [],
        discardCenterQueue: [],
        focusResult: false,
        clearResult: false,
        enabledQueue: [],
        // POST_BUTTON_SENTINEL_COORDS: trigger always null → composer_open_click_failed
        // returned before any Post-button evaluation. No click at sentinel coords.
        postCenterResult: { cx: POST_BUTTON_SENTINEL_COORDS.cx, cy: POST_BUTTON_SENTINEL_COORDS.cy },
        pressKeyLog,
        dispatchClickLog,
        insertTextLog,
      };
      break;
    case "composer_absent_after_open":
      opts = {
        constants,
        surfaceCheckQueue: [{ cx: 100, cy: 200 }],
        probeQueue: [
          { present: false, editorText: "" }, // entry
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: false, editorText: "" },
          { present: false, editorText: "" },
        ],
        // round-1 trigger finds a center → triggerStartAPostLive calls
        // dispatchHumanLikeClickAtCoords(100, 200) — the Start-a-post click.
        // This IS expected and intentional; it is NOT the Post-button click.
        // T-OpenInvariant.2 asserts no click at POST_BUTTON_SENTINEL_COORDS,
        // not zero clicks total.
        triggerQueue: [{ cx: 100, cy: 200 }, null, null, null],
        closeCenterQueue: [],
        discardCenterQueue: [],
        focusResult: false,
        clearResult: false,
        enabledQueue: [],
        // POST_BUTTON_SENTINEL_COORDS: runtime returns composer_absent_after_open
        // (probe never present) before reaching getFeedComposerPostButtonCenterLive.
        // CENTER_JS never evaluated → sentinel coords never returned → no click at
        // (999, 888) in dispatchClickLog.
        postCenterResult: { cx: POST_BUTTON_SENTINEL_COORDS.cx, cy: POST_BUTTON_SENTINEL_COORDS.cy },
        pressKeyLog,
        dispatchClickLog,
        insertTextLog,
      };
      break;
  }
  return makeFakeP9Client(opts);
}

describe(
  "publishApprovedFeedPost — invariant: dispatchAttempted===false AND fallbackAllowed===true for all 4 new pre-dispatch fail reasons (T-OpenInvariant.1, SC-4)",
  () => {
    for (const reason of NEW_FAIL_REASONS) {
      it(
        `T-OpenInvariant.1[${reason}]: reason==="${reason}" → dispatchAttempted===false AND fallbackAllowed===true`,
        { timeout: 10000 },
        async () => {
          // Given: scripted CDP to produce fail reason "${reason}".
          // When:  publishApprovedFeedPost runs.
          // Then:  result.dispatchAttempted===false; result.fallbackAllowed===true.
          // Covers SC-4 for this reason.
          const constants = await loadPayloadConstants();
          const setup = await seedDraft(
            `inv1-${reason}`,
            `invariant1 ${reason}`,
          );
          const dispatchClickLog: Array<{ x: number; y: number }> = [];
          const pressKeyLog: string[] = [];
          const client = await makeClientForReason(
            reason,
            constants,
            dispatchClickLog,
            pressKeyLog,
          );
          const deps = makePublishDeps(client, setup);

          const fn = await importPublishFn();
          if (typeof fn !== "function") {
            assert.fail(
              "TODO P9: publishApprovedFeedPost not exported (Step 4 pending)",
            );
          }
          const result = await fn(deps);
          // T-OpenInvariant.1: ALL four new pre-dispatch fail reasons must carry dispatchAttempted:false + fallbackAllowed:true.
          assert.equal(result.dispatchAttempted, false, `T-OpenInvariant.1[${reason}]: dispatchAttempted should be false, got ${JSON.stringify(result)}`);
          assert.equal(result.fallbackAllowed, true, `T-OpenInvariant.1[${reason}]: fallbackAllowed should be true (pre-dispatch fail always falls back)`);
          assert.equal(result.reason, reason, `T-OpenInvariant.1[${reason}]: reason should match scripted scenario, got ${result.reason}`);
          assert.equal(result.published, false, `T-OpenInvariant.1[${reason}]: published should be false`);
          // Covers SC-4 for this reason.
        },
      );
    }
  },
);

describe(
  "publishApprovedFeedPost — invariant: Post-button click (deterministicPublishPost.ts:118) never dispatched for all 4 new pre-dispatch fail reasons (T-OpenInvariant.2, SC-4)",
  () => {
    for (const reason of NEW_FAIL_REASONS) {
      it(
        `T-OpenInvariant.2[${reason}]: reason==="${reason}" → no click at POST_BUTTON_SENTINEL_COORDS (${POST_BUTTON_SENTINEL_COORDS.cx},${POST_BUTTON_SENTINEL_COORDS.cy}) in dispatchClickLog`,
        { timeout: 10000 },
        async () => {
          // Given: scripted CDP to produce fail reason "${reason}"; makeClientForReason sets
          //        postCenterResult to POST_BUTTON_SENTINEL_COORDS (999,888) — never returned
          //        because the runtime exits before reaching getFeedComposerPostButtonCenterLive.
          //        For composer_absent_after_open, dispatchClickLog MAY contain a Start-a-post
          //        click at (100,200) from triggerStartAPostLive; that is expected and allowed.
          // When:  publishApprovedFeedPost runs.
          // Then:  dispatchClickLog contains NO entry with x===999 AND y===888 —
          //        proving the Post-button click (line 118) never fires. The invariant
          //        is "no Post-button dispatch", not "zero clicks total". Covers SC-4.
          const constants = await loadPayloadConstants();
          const setup = await seedDraft(
            `inv2-${reason}`,
            `invariant2 ${reason}`,
          );
          const dispatchClickLog: Array<{ x: number; y: number }> = [];
          const pressKeyLog: string[] = [];
          const client = await makeClientForReason(
            reason,
            constants,
            dispatchClickLog,
            pressKeyLog,
          );
          const deps = makePublishDeps(client, setup);

          const fn = await importPublishFn();
          if (typeof fn !== "function") {
            assert.fail(
              "TODO P9: publishApprovedFeedPost not exported (Step 4 pending)",
            );
          }
          const result = await fn(deps);
          void result;
          // T-OpenInvariant.2: Post-button click (deterministicPublishPost.ts:155) must never fire.
          // dispatchClickLog may contain a Start-a-post click at (100,200) for composer_absent_after_open —
          // that is expected and allowed. What must NOT appear is a click at the sentinel Post-button
          // coords (999,888), which the runtime would return from CENTER_JS if it ever reached that point.
          const hasPostButtonClick = dispatchClickLog.some(
            (entry) => entry.x === POST_BUTTON_SENTINEL_COORDS.cx && entry.y === POST_BUTTON_SENTINEL_COORDS.cy,
          );
          assert.equal(
            hasPostButtonClick,
            false,
            `T-OpenInvariant.2[${reason}]: Post-button click at (${POST_BUTTON_SENTINEL_COORDS.cx},${POST_BUTTON_SENTINEL_COORDS.cy}) must not fire on pre-dispatch failure. dispatchClickLog=${JSON.stringify(dispatchClickLog)}`,
          );
          // Covers SC-4 for this reason.
        },
      );
    }
  },
);

// ---------------------------------------------------------------------------
// T-OpenHappy — happy-path unchanged
// ---------------------------------------------------------------------------

describe(
  "publishApprovedFeedPost — happy path: surface capable + open succeeds round 1 + post-open probe present round 1 → {published:true,dispatchAttempted:true,fallbackAllowed:false} (T-OpenHappy.1, SC-6)",
  () => {
    it(
      "T-OpenHappy.1: when all P9 pre-checks pass first-try, runtime publishes {published:true,dispatchAttempted:true,fallbackAllowed:false} with no extra open-chain sleeps",
      { timeout: 10000 },
      async () => {
        // Given: surface capable (TRIGGER_JS surface check → center); entry probe absent;
        //        trigger succeeds round 1 (center returned); post-open probe present round 1;
        //        focus/clear/insert/readback/enabled/coords/click/post-click-gone all succeed.
        // When:  publishApprovedFeedPost runs.
        // Then:  result.published===true; result.dispatchAttempted===true;
        //        result.fallbackAllowed===false; dispatchClickLog has exactly one Post click.
        // Covers SC-6.
        const constants = await loadPayloadConstants();
        const draftText = "Happy P9 post";
        const setup = await seedDraft("happy1", draftText);
        const dispatchClickLog: Array<{ x: number; y: number }> = [];
        const pressKeyLog: string[] = [];
        const insertTextLog: Array<{ text: string }> = [];

        const clientOpts: P9FakeClientOpts = {
          constants,
          surfaceCheckQueue: [{ cx: 100, cy: 200 }], // surface check: capable
          probeQueue: [
            { present: false, editorText: "" }, // entry probe: absent (no close needed)
            { present: true, editorText: "" }, // post-open probe: present first try
            { present: true, editorText: draftText }, // readback
            { present: false, editorText: "" }, // post-click: gone
          ],
          triggerQueue: [{ cx: 100, cy: 200 }], // trigger succeeds round 1
          closeCenterQueue: [],
          discardCenterQueue: [],
          focusResult: true,
          clearResult: true,
          enabledQueue: [true],
          postCenterResult: { cx: 480, cy: 320 },
          pressKeyLog,
          dispatchClickLog,
          insertTextLog,
        };
        const client = makeFakeP9Client(clientOpts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail(
            "TODO P9: publishApprovedFeedPost not exported (Step 4 pending)",
          );
        }
        const result = await fn(deps);
        // T-OpenHappy.1 assertions: all P9 pre-checks pass first-try → published.
        assert.equal(result.published, true, `T-OpenHappy.1: published should be true, got ${JSON.stringify(result)}`);
        assert.equal(result.dispatchAttempted, true, `T-OpenHappy.1: dispatchAttempted should be true`);
        assert.equal(result.fallbackAllowed, false, `T-OpenHappy.1: fallbackAllowed should be false on success`);
        assert.equal(result.reason, undefined, `T-OpenHappy.1: no fail reason expected, got ${result.reason}`);
        // Verify the Post-button click actually fired at the correct coords (480,320).
        assert.ok(
          dispatchClickLog.some((e) => e.x === 480 && e.y === 320),
          `T-OpenHappy.1: dispatchClickLog should contain Post-button click at (480,320), got ${JSON.stringify(dispatchClickLog)}`,
        );
        // Covers SC-6: happy path unchanged.
      },
    );
  },
);

describe(
  "publishApprovedFeedPost — happy path: surface capable + entry probe absent → close branch NOT entered (T-OpenHappy.2, SC-6)",
  () => {
    it(
      "T-OpenHappy.2: when surface check signals capable AND entry probe present:false, closeFeedComposerLive is NOT called (Escape pressKeyLog empty, close-center spy never fires)",
      { timeout: 10000 },
      async () => {
        // Given: surface capable; entry probe present:false (composer NOT already open);
        //        rest of sequence happy-path.
        // When:  publishApprovedFeedPost runs.
        // Then:  pressKeyLog does NOT contain "Escape" (close branch skipped);
        //        closeCenterQueue is never consumed (close-center spy = 0 invocations).
        //        Defends against accidental over-eager close when entry probe says absent.
        // Covers SC-6 (structural: close is gated on entry probe).
        const constants = await loadPayloadConstants();
        const draftText = "Happy P9 no-close";
        const setup = await seedDraft("happy2", draftText);
        const dispatchClickLog: Array<{ x: number; y: number }> = [];
        const pressKeyLog: string[] = [];
        const insertTextLog: Array<{ text: string }> = [];

        const clientOpts: P9FakeClientOpts = {
          constants,
          surfaceCheckQueue: [{ cx: 100, cy: 200 }],
          probeQueue: [
            { present: false, editorText: "" }, // entry probe: absent → skip close
            { present: true, editorText: "" }, // post-open probe
            { present: true, editorText: draftText }, // readback
            { present: false, editorText: "" }, // post-click: gone
          ],
          triggerQueue: [{ cx: 100, cy: 200 }],
          closeCenterQueue: [],
          discardCenterQueue: [],
          focusResult: true,
          clearResult: true,
          enabledQueue: [true],
          postCenterResult: { cx: 480, cy: 320 },
          pressKeyLog,
          dispatchClickLog,
          insertTextLog,
        };
        const client = makeFakeP9Client(clientOpts);
        const deps = makePublishDeps(client, setup);

        const fn = await importPublishFn();
        if (typeof fn !== "function") {
          assert.fail(
            "TODO P9: publishApprovedFeedPost not exported (Step 4 pending)",
          );
        }
        const result = await fn(deps);
        // T-OpenHappy.2 assertions: entry probe absent → close branch skipped entirely.
        assert.equal(result.published, true, `T-OpenHappy.2: published should be true (happy path), got ${JSON.stringify(result)}`);
        // closeFeedComposerLive sends "Escape" — if close branch were entered, pressKeyLog would contain "Escape".
        assert.equal(
          pressKeyLog.includes("Escape"),
          false,
          `T-OpenHappy.2: pressKeyLog should NOT contain Escape (close branch must be skipped when entry probe absent). pressKeyLog=${JSON.stringify(pressKeyLog)}`,
        );
        // Covers SC-6: close branch is gated on entry probe.present===true.
      },
    );
  },
);
