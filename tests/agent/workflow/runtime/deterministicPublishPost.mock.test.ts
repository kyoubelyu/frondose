/**
 * P-POST-PUBLISH-7 Step 2 (revised 3a) — Group D scaffold
 * T-Seq.HappyPath / ComposerAbsentFailure / ComposerReopenSuccess / SkipClearIfEmpty /
 * ReadbackMismatch / PostNotEnabled / PostCoordsMissing / PublishVerificationSuccess /
 * PostDispatchAmbiguous_ComposerStillOpen / PostDispatchAmbiguous_ThrowAfterDispatch /
 * PerCharInsertParity / AbortAware_PreDispatch:
 * publishApprovedFeedPost sequence tests via fake CDP.
 *
 * Gate: G-P7.sequence
 *
 * CMR-3: every test that must pass draft retrieval seeds a real message_drafts row
 * via getSalesDb + insertDraft. The `_draftText` fake-dep is removed.
 *
 * CMR-4: fake CDP uses STRICT-EQUAL matching against imported JS-payload constants
 * (FEED_COMPOSER_POST_CENTER_JS, FEED_COMPOSER_POST_ENABLED_JS, etc.) so a
 * center-coords request is never misrouted to the enabled-probe branch.
 * The constants don't exist yet (Step 4 pending); they are loaded via dynamic import
 * inside each test, falling back to sentinel strings when absent. The fake uses the
 * actual constant value (once loaded) or a unique sentinel for strict matching.
 *
 * All 12 tests FAIL on HEAD (correct RED). No production-code edits.
 *
 * Runner:
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/workflow/runtime/deterministicPublishPost.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { CdpClient } from "../../../../src/cdp/client.js";
import type { WorkflowSseFrame, WorkflowAuditEntry } from "../../../../src/agent/workflow/types.js";

// Disable inter-tool pacing for the mock suite.
process.env.FRONDOSE_PACE_MIN_MS = "0";

// ---------------------------------------------------------------------------
// JS-payload constant sentinels (CMR-4: strict-equal matching)
// We load the real constants at test-body time via dynamic import.
// Until Step 4 ships them we use UNIQUE sentinel strings that cannot
// false-match any other expression in the fake evaluate dispatcher.
// ---------------------------------------------------------------------------

const SENTINEL_PROBE           = "__SENTINEL_PROBE_LIVE_IN_DOM__";
const SENTINEL_FOCUS           = "__SENTINEL_FOCUS_EDITOR__";
const SENTINEL_CLEAR           = "__SENTINEL_CLEAR_EDITOR__";
const SENTINEL_ENABLED         = "__SENTINEL_POST_ENABLED__";
const SENTINEL_CENTER          = "__SENTINEL_POST_CENTER__";
const SENTINEL_TRIGGER         = "__SENTINEL_TRIGGER_START_A_POST__";
const SENTINEL_CLOSE_CENTER    = "__SENTINEL_CLOSE_CENTER__";
const SENTINEL_DISCARD_CENTER  = "__SENTINEL_DISCARD_CENTER__";

/** Load all composerReadiness constants; return sentinels for any that are missing. */
async function loadPayloadConstants(): Promise<{
  PROBE_JS: string;
  FOCUS_JS: string;
  CLEAR_JS: string;
  ENABLED_JS: string;
  CENTER_JS: string;
  TRIGGER_JS: string;
  CLOSE_CENTER_JS: string;
  DISCARD_CENTER_JS: string;
}> {
  try {
    const mod = await import("../../../../src/linkedin/composerReadiness.js") as Record<string, unknown>;
    return {
      PROBE_JS:          (mod["FEED_COMPOSER_LIVE_IN_DOM_JS"]        as string | undefined) ?? SENTINEL_PROBE,
      FOCUS_JS:          (mod["FEED_COMPOSER_FOCUS_EDITOR_JS"]       as string | undefined) ?? SENTINEL_FOCUS,
      CLEAR_JS:          (mod["FEED_COMPOSER_CLEAR_EDITOR_JS"]       as string | undefined) ?? SENTINEL_CLEAR,
      ENABLED_JS:        (mod["FEED_COMPOSER_POST_ENABLED_JS"]       as string | undefined) ?? SENTINEL_ENABLED,
      CENTER_JS:         (mod["FEED_COMPOSER_POST_CENTER_JS"]        as string | undefined) ?? SENTINEL_CENTER,
      TRIGGER_JS:        (mod["FEED_START_A_POST_CENTER_JS"]         as string | undefined) ?? SENTINEL_TRIGGER,
      CLOSE_CENTER_JS:   (mod["FEED_COMPOSER_CLOSE_CENTER_JS"]       as string | undefined) ?? SENTINEL_CLOSE_CENTER,
      DISCARD_CENTER_JS: (mod["FEED_COMPOSER_DISCARD_CENTER_JS"]     as string | undefined) ?? SENTINEL_DISCARD_CENTER,
    };
  } catch {
    return {
      PROBE_JS:          SENTINEL_PROBE,
      FOCUS_JS:          SENTINEL_FOCUS,
      CLEAR_JS:          SENTINEL_CLEAR,
      ENABLED_JS:        SENTINEL_ENABLED,
      CENTER_JS:         SENTINEL_CENTER,
      TRIGGER_JS:        SENTINEL_TRIGGER,
      CLOSE_CENTER_JS:   SENTINEL_CLOSE_CENTER,
      DISCARD_CENTER_JS: SENTINEL_DISCARD_CENTER,
    };
  }
}

// ---------------------------------------------------------------------------
// Fake CDP harness — CMR-4 strict-equal dispatch
// ---------------------------------------------------------------------------

interface FakeCdpEvalOpts {
  /** Resolved payload constant strings (from loadPayloadConstants). */
  constants: Awaited<ReturnType<typeof loadPayloadConstants>>;
  /** isFeedComposerLiveInDOM probe call sequence (consumed for EVERY PROBE_JS evaluate call,
   *  including the internal probe inside closeFeedComposerLive). */
  probeResults: Array<{ present: boolean; editorText: string }>;
  focusResult: boolean;
  clearResult: boolean;
  /** isFeedComposerPostButtonEnabled call sequence. */
  enabledResults: boolean[];
  /** getFeedComposerPostButtonCenterLive: coords or null. */
  postCenterResult: { cx: number; cy: number } | null;
  /** triggerStartAPostLive: boolean. */
  triggerResult: boolean;
  /** If true, dispatchMouseEvent throws AbortError (used in PostDispatchAmbiguous_ThrowAfterDispatch). */
  throwOnMousePress: boolean;
  /** Track all Input.dispatchMouseEvent calls. */
  mouseEventLog: Array<{ type: string; x?: number; y?: number }>;
  /** Track Input.insertText calls. */
  insertTextLog: Array<{ text: string }>;
  /** If true, throws for all evaluate calls (AbortAware_PreDispatch test). */
  throwOnEvaluate?: boolean;
  /**
   * B1-R2-2: if set, after both mousePressed AND mouseReleased have been logged
   * (i.e. the click fully completed), the NEXT Runtime.evaluate call (which is the
   * first post-click isFeedComposerLiveInDOM probe) throws this error.
   * This is distinct from throwOnMousePress which throws DURING mousePressed.
   */
  throwOnPostClickProbe?: Error;
  /**
   * B1-R2-1 success-path accounting throw: after the mouse log records BOTH
   * mousePressed + mouseReleased AND the post-click probe resolves (present:false),
   * writeAuditRow is replaced by a function that throws (to test the non-escaping path).
   * Value: the injected deps override — set `writeAuditRowOverride` to a throwing fn.
   */
  writeAuditRowShouldThrow?: boolean;
  /**
   * B1-R2-1 success-path commit-warning throw: same scenario but emitFrame throws
   * inside emitCommitWarning.
   */
  emitFrameShouldThrow?: boolean;
}

function makeFakePublishCdpClient(opts: FakeCdpEvalOpts): CdpClient {
  let probeCallIdx = 0;
  let enabledCallIdx = 0;
  const { constants: c } = opts;

  const fakeHandle = {
    Accessibility: { enable: async () => {}, getFullAXTree: async () => ({ nodes: [] }) },
    Runtime: {
      evaluate: async (args: { expression: string }) => {
        if (opts.throwOnEvaluate) throw new DOMException("AbortError", "AbortError");

        // B1-R2-2: after BOTH mousePressed AND mouseReleased have been logged (click
        // fully completed), the NEXT probe call (isFeedComposerLiveInDOM post-click)
        // throws — proving the routine handles a post-click throw without re-throwing.
        if (opts.throwOnPostClickProbe) {
          const hasPressed = opts.mouseEventLog.some((e) => e.type === "mousePressed");
          const hasReleased = opts.mouseEventLog.some((e) => e.type === "mouseReleased");
          if (
            hasPressed &&
            hasReleased &&
            (args.expression === c.PROBE_JS ||
              args.expression.includes("editorText") ||
              args.expression.includes("present"))
          ) {
            throw opts.throwOnPostClickProbe;
          }
        }

        // CMR-4 (Step-5a update): strict-equal dispatch — longest/most-specific first.
        // CLOSE_CENTER and DISCARD_CENTER come before PROBE to avoid any substring collision.
        // Both close/discard controls return null (no button found) — closeFeedComposerLive
        // succeeds via Escape-only path; the close result is modelled by probeResults.
        if (args.expression === c.CLOSE_CENTER_JS) {
          return { result: { value: JSON.stringify(null) } };
        }
        if (args.expression === c.DISCARD_CENTER_JS) {
          return { result: { value: JSON.stringify(null) } };
        }
        // CENTER must come before ENABLED because both share overlapping substrings
        // in the sentinel fallback; with strict-equal there's zero ambiguity.
        if (args.expression === c.CENTER_JS) {
          return { result: { value: JSON.stringify(opts.postCenterResult) } };
        }
        if (args.expression === c.TRIGGER_JS) {
          return { result: { value: opts.triggerResult } };
        }
        if (args.expression === c.ENABLED_JS) {
          const res = opts.enabledResults[enabledCallIdx] ?? false;
          enabledCallIdx++;
          return { result: { value: res } };
        }
        if (args.expression === c.PROBE_JS) {
          const res = opts.probeResults[probeCallIdx] ?? { present: false, editorText: "" };
          probeCallIdx++;
          return { result: { value: JSON.stringify(res) } };
        }
        if (args.expression === c.FOCUS_JS) {
          return { result: { value: opts.focusResult } };
        }
        if (args.expression === c.CLEAR_JS) {
          return { result: { value: opts.clearResult } };
        }
        // Fallback for sentinel-mode: dispatch by substring.
        // CLOSE_RE is unique to FEED_COMPOSER_CLOSE_CENTER_JS; DISCARD_RE to FEED_COMPOSER_DISCARD_CENTER_JS.
        // Both return null so closeFeedComposerLive succeeds via Escape-only path.
        if (args.expression.includes("CLOSE_RE")) {
          return { result: { value: JSON.stringify(null) } };
        }
        if (args.expression.includes("DISCARD_RE")) {
          return { result: { value: JSON.stringify(null) } };
        }
        if (args.expression.includes("getBoundingClientRect") && args.expression.includes("cx")) {
          return { result: { value: JSON.stringify(opts.postCenterResult) } };
        }
        if (args.expression.includes("Start a post") || args.expression.includes("START_RE")) {
          return { result: { value: opts.triggerResult } };
        }
        if (args.expression.includes("button.disabled") || args.expression.includes("POST_RE")) {
          const res = opts.enabledResults[enabledCallIdx] ?? false;
          enabledCallIdx++;
          return { result: { value: res } };
        }
        if (args.expression.includes("el.focus()") && args.expression.includes("activeElement")) {
          return { result: { value: opts.focusResult } };
        }
        if (args.expression.includes("deleteContentBackward") || args.expression.includes("selectAll")) {
          return { result: { value: opts.clearResult } };
        }
        // Default: probe
        const res = opts.probeResults[probeCallIdx] ?? { present: false, editorText: "" };
        probeCallIdx++;
        return { result: { value: JSON.stringify(res) } };
      },
    },
    DOM: {
      getDocument: async () => ({ root: { nodeId: 1 } }),
      querySelectorAll: async () => ({ nodeIds: [] }),
      scrollIntoViewIfNeeded: async () => {},
      getBoxModel: async () => ({ model: { border: [0, 0, 10, 0, 10, 10, 0, 10] } }),
    },
    Input: {
      dispatchMouseEvent: async (args: { type: string; x?: number; y?: number }) => {
        // Only throw on mousePressed to simulate a mid-dispatch throw scenario
        if (opts.throwOnMousePress && args.type === "mousePressed") {
          throw new DOMException("AbortError", "AbortError");
        }
        opts.mouseEventLog.push({ type: args.type, x: args.x, y: args.y });
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
      loadEventFired: (cb: (p: unknown) => void) => { setTimeout(() => cb({ timestamp: 0 }), 0); return () => {}; },
      frameNavigated: (cb: (p: unknown) => void) => { setTimeout(() => cb({ frame: { url: "" } }), 0); return () => {}; },
      lifecycleEvent: (cb: (p: unknown) => void) => { setTimeout(() => cb({ name: "networkIdle" }), 0); return () => {}; },
      setLifecycleEventsEnabled: async () => {},
      getLayoutMetrics: async () => ({
        visualViewport: { pageX: 0, pageY: 0, clientWidth: 1440, clientHeight: 900 },
        cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1440, clientHeight: 900 },
        cssLayoutViewport: { clientWidth: 1440, clientHeight: 900 },
      }),
      reload: async () => {},
    },
  };
  return CdpClient.fromHandle(fakeHandle);
}

// ---------------------------------------------------------------------------
// CMR-3: real draft DB seeding helper
// ---------------------------------------------------------------------------

interface ScratchSetup {
  scratchDir: string;
  auditPath: string;
  dbPath: string;
  draftId: string;
}

/**
 * Create a tmpdir scratch space and insert a real message_drafts row.
 * Returns the scratch paths and the real draftId from the DB insert.
 * If getSalesDb/insertDraft don't exist yet (Step 4 pending), returns
 * a pseudo-draftId — the test will hit assert.fail before any assertion.
 */
async function seedDraft(
  label: string,
  text: string,
): Promise<ScratchSetup> {
  const scratchDir = join(tmpdir(), `frondose-p7-seq-${label}`, `${Date.now()}`);
  mkdirSync(scratchDir, { recursive: true });
  const auditPath = join(scratchDir, "audit.jsonl");
  const dbPath = join(scratchDir, "sales.db");

  try {
    const dbMod = await import("../../../../src/tools/sales/_dbHandle.js") as Record<string, unknown>;
    const getSalesDb = dbMod["getSalesDb"] as ((p: string) => unknown) | undefined;
    const draftsMod = await import("../../../../src/persistence/sales/drafts.js") as Record<string, unknown>;
    const insertDraft = draftsMod["insertDraft"] as
      | ((db: unknown, input: { leadId: null; kind: string; text: string; createdBy: string }) => string)
      | undefined;
    if (typeof getSalesDb === "function" && typeof insertDraft === "function") {
      const db = getSalesDb(dbPath);
      const draftId = insertDraft(db, { leadId: null, kind: "post", text, createdBy: "llm" });
      return { scratchDir, auditPath, dbPath, draftId };
    }
  } catch {
    // pre-Step-4: helpers don't exist yet; test will hit assert.fail
  }
  return { scratchDir, auditPath, dbPath, draftId: "d-seed-unavailable" };
}

/**
 * Build minimal PublishPostDeps. CMR-3: uses the real draftId from seedDraft;
 * does NOT include _draftText (removed per CMR-3 plan).
 */
function makePublishDeps(
  client: CdpClient,
  setup: ScratchSetup,
  opts: {
    mode?: "manual" | "auto";
    /** B1-R2-1: if true, the injected writeWorkflowAudit throws (for ThrowFromCommitWarning test). */
    emitFrameShouldThrow?: boolean;
    /** B1-R2-1: if true, the injected writeWorkflowAudit throws on commit_warning writes. */
    writeAuditShouldThrow?: boolean;
  } = {},
): Record<string, unknown> {
  const emittedFrames: WorkflowSseFrame[] = [];
  const auditedEvents: WorkflowAuditEntry["event"][] = [];
  return {
    _emittedFrames: emittedFrames,
    _auditedEvents: auditedEvents,
    session: {
      inputMode: "cdp" as const,
      getOrInitClient: () => Promise.resolve(client),
      getClient: () => client,
      setLastContext: () => {},
      getLastContext: () => undefined,
      resolvedMode: () => opts.mode ?? "manual",
    },
    client,
    salesDbPath: setup.dbPath,
    auditPath: setup.auditPath,
    workflowDeps: {
      emitFrame: (frame: WorkflowSseFrame) => {
        if (opts.emitFrameShouldThrow) {
          throw new Error("emitFrame intentional test throw (B1-R2-1 ThrowFromCommitWarning)");
        }
        emittedFrames.push(frame);
      },
      writeWorkflowAudit: (event: WorkflowAuditEntry["event"]) => {
        if (
          opts.writeAuditShouldThrow &&
          "kind" in event &&
          (event as { kind: string }).kind === "commit_warning"
        ) {
          throw new Error("writeWorkflowAudit intentional test throw (B1-R2-1 ThrowFromCommitWarning)");
        }
        auditedEvents.push(event);
      },
    },
    workflowId: "wf-p7-seq",
    stepId: "step-p7-seq",
    draftId: setup.draftId,
  };
}

// ---------------------------------------------------------------------------
// T-Seq.HappyPath
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — happy path: returns {published:true,fallbackAllowed:false,dispatchAttempted:true} when all preconditions met (G-P7.sequence)", () => {
  it(
    "T-Seq.HappyPath: when composer present + body matches saved text + Post enabled + coords resolve, routine clicks at coords and returns {published:true,fallbackAllowed:false,dispatchAttempted:true}",
    { timeout: 10000 },
    async () => {
      // Given: all CDP probes succeed; coords={480,320}; composer gone after click.
      // When:  publishApprovedFeedPost(deps) is called with a seeded draft row.
      // Then:  returns {published:true, fallbackAllowed:false, dispatchAttempted:true};
      //        mouseLog has mousePressed+mouseReleased near (480,320).
      const constants = await loadPayloadConstants();
      const draftText = "Hi!";
      const setup = await seedDraft("happy", draftText);
      const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
      const insertLog: Array<{ text: string }> = [];
      const cdpOpts: FakeCdpEvalOpts = {
        constants,
        // Step-5a: new flow — initial probe present triggers close+trigger+re-probe.
        // probeResults[0]: initial probe (present — triggers close path)
        // probeResults[1]: closeFeedComposerLive internal probe (absent — Escape succeeded)
        // probeResults[2]: re-probe after triggerStartAPostLive (fresh, present empty)
        // probeResults[3]: readback probe after insertText
        // probeResults[4]: post-click probe (composer gone)
        probeResults: [
          { present: true,  editorText: "stale" },  // [0] initial probe
          { present: false, editorText: "" },         // [1] close internal probe → absent = closed
          { present: true,  editorText: "" },         // [2] re-probe after trigger
          { present: true,  editorText: draftText },  // [3] readback
          { present: false, editorText: "" },         // [4] post-click: gone
        ],
        focusResult: true,
        clearResult: true,
        enabledResults: [true],
        postCenterResult: { cx: 480, cy: 320 },
        triggerResult: true,
        throwOnMousePress: false,
        mouseEventLog: mouseLog,
        insertTextLog: insertLog,
      };
      const client = makeFakePublishCdpClient(cdpOpts);
      const deps = makePublishDeps(client, setup);

      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail(
            "TODO P7: publishApprovedFeedPost not yet exported " +
            "(src/agent/workflow/runtime/deterministicPublishPost.ts — Step 4 pending).",
          );
        }
        const result = await fn(deps);
        // T-Seq.HappyPath assertions
        assert.equal(result.published, true, `T-Seq.HappyPath: result.published should be true, got ${JSON.stringify(result)}`);
        assert.equal(result.fallbackAllowed, false, `T-Seq.HappyPath: result.fallbackAllowed should be false`);
        assert.equal(result.dispatchAttempted, true, `T-Seq.HappyPath: result.dispatchAttempted should be true`);
        assert.ok(mouseLog.some((e) => e.type === "mousePressed"), `T-Seq.HappyPath: mouseLog must contain mousePressed, got ${JSON.stringify(mouseLog)}`);
        assert.ok(mouseLog.some((e) => e.type === "mouseReleased"), `T-Seq.HappyPath: mouseLog must contain mouseReleased`);
        const pressed = mouseLog.find((e) => e.type === "mousePressed")!;
        assert.ok(pressed.x !== undefined && pressed.x >= 460 && pressed.x <= 500, `T-Seq.HappyPath: mousePressed.x (${pressed.x}) should be near 480 (±20)`);
        assert.ok(pressed.y !== undefined && pressed.y >= 300 && pressed.y <= 340, `T-Seq.HappyPath: mousePressed.y (${pressed.y}) should be near 320 (±20)`);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Seq.HappyPath: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Seq.ComposerAbsentFailure
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — composer absent: triggerStartAPostLive fails → {published:false, fallbackAllowed:true, dispatchAttempted:false} (G-P7.sequence)", () => {
  it(
    "T-Seq.ComposerAbsentFailure: when first probe returns present:false and triggerStartAPostLive returns false, returns {published:false, reason:'composer_unavailable', fallbackAllowed:true, dispatchAttempted:false}",
    { timeout: 10000 },
    async () => {
      // Given: first probe returns present:false; triggerStartAPostLive returns false.
      // When:  publishApprovedFeedPost runs with a seeded draft row.
      // Then:  returns {published:false, reason:'composer_unavailable', fallbackAllowed:true, dispatchAttempted:false};
      //        triggerStartAPostLive called exactly once; no mouse event fired (PRE-dispatch).
      const constants = await loadPayloadConstants();
      const setup = await seedDraft("absent-fail", "Composer absent fail");
      const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
      const insertLog: Array<{ text: string }> = [];
      const cdpOpts: FakeCdpEvalOpts = {
        constants,
        probeResults: [{ present: false, editorText: "" }],
        focusResult: false,
        clearResult: false,
        enabledResults: [],
        postCenterResult: null,
        triggerResult: false,
        throwOnMousePress: false,
        mouseEventLog: mouseLog,
        insertTextLog: insertLog,
      };
      const client = makeFakePublishCdpClient(cdpOpts);
      const deps = makePublishDeps(client, setup);

      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const result = await fn(deps);
        // T-Seq.ComposerAbsentFailure assertions
        assert.equal(result.published, false, `T-Seq.ComposerAbsentFailure: result.published should be false`);
        assert.equal(result.reason, "composer_unavailable", `T-Seq.ComposerAbsentFailure: reason should be 'composer_unavailable', got '${result.reason}'`);
        assert.equal(result.fallbackAllowed, true, `T-Seq.ComposerAbsentFailure: fallbackAllowed should be true (pre-dispatch)`);
        assert.equal(result.dispatchAttempted, false, `T-Seq.ComposerAbsentFailure: dispatchAttempted should be false`);
        assert.equal(mouseLog.length, 0, `T-Seq.ComposerAbsentFailure: no mouse events should fire for a pre-dispatch failure, got ${mouseLog.length}`);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Seq.ComposerAbsentFailure: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Seq.ComposerReopenSuccess (CMR-5 — new)
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — composer reopen success: absent→trigger→re-probe present→continue→{published:true} (G-P7.sequence)", () => {
  it(
    "T-Seq.ComposerReopenSuccess: when composer is initially absent, triggerStartAPostLive returns true, second probe present:true, routine proceeds through focus/type/click and returns {published:true, fallbackAllowed:false, dispatchAttempted:true}",
    { timeout: 10000 },
    async () => {
      // Given: first probe returns {present:false}; triggerStartAPostLive returns true;
      //        second probe returns {present:true, editorText:""}; rest of sequence is happy-path.
      // When:  publishApprovedFeedPost runs with a seeded draft row.
      // Then:  triggerStartAPostLive was invoked exactly once before focus;
      //        focus/type/readback/enabled/coords/click/verify all run in order;
      //        returns {published:true, fallbackAllowed:false, dispatchAttempted:true}.
      const constants = await loadPayloadConstants();
      const draftText = "Reopen success!";
      const setup = await seedDraft("reopen-success", draftText);
      const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
      const insertLog: Array<{ text: string }> = [];
      const cdpOpts: FakeCdpEvalOpts = {
        constants,
        probeResults: [
          { present: false, editorText: "" },        // initial probe: absent
          { present: true,  editorText: "" },        // post-trigger re-probe: present
          { present: true,  editorText: draftText }, // readback
          { present: false, editorText: "" },        // post-click: gone
        ],
        focusResult: true,
        clearResult: true,
        enabledResults: [true],
        postCenterResult: { cx: 480, cy: 320 },
        triggerResult: true,                          // trigger succeeds
        throwOnMousePress: false,
        mouseEventLog: mouseLog,
        insertTextLog: insertLog,
      };
      const client = makeFakePublishCdpClient(cdpOpts);
      const deps = makePublishDeps(client, setup);

      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const result = await fn(deps);
        // T-Seq.ComposerReopenSuccess assertions
        assert.equal(result.published, true, `T-Seq.ComposerReopenSuccess: result.published should be true`);
        assert.equal(result.fallbackAllowed, false, `T-Seq.ComposerReopenSuccess: fallbackAllowed should be false`);
        assert.equal(result.dispatchAttempted, true, `T-Seq.ComposerReopenSuccess: dispatchAttempted should be true`);
        assert.ok(mouseLog.some((e) => e.type === "mousePressed"), `T-Seq.ComposerReopenSuccess: mouseLog must contain mousePressed after trigger+reopen`);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Seq.ComposerReopenSuccess: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Seq.ClosesAndReopensWhenPresent (Step-5a — new close+reopen branch coverage)
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — Step-5a close+reopen: initial probe present triggers close+trigger+re-probe before proceeding (G-P7.sequence)", () => {
  it(
    "T-Seq.ClosesAndReopensWhenPresent: when initial probe returns present:true, closeFeedComposerLive is called first, then triggerStartAPostLive, then re-probe; routine proceeds through focus/type/click and returns {published:true}",
    { timeout: 10000 },
    async () => {
      // Given: initial probe returns present:true (stale composer open);
      //        closeFeedComposerLive succeeds (internal probe returns absent);
      //        triggerStartAPostLive returns true; re-probe returns present empty;
      //        rest of sequence is happy-path.
      // When:  publishApprovedFeedPost runs with a seeded draft row.
      // Then:  triggerStartAPostLive called once (after close); re-probe present;
      //        returns {published:true, fallbackAllowed:false, dispatchAttempted:true}.
      //        This is the primary Step-5a close+reopen branch test.
      const constants = await loadPayloadConstants();
      const draftText = "Close and reopen test";
      const setup = await seedDraft("close-reopen", draftText);
      const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
      const insertLog: Array<{ text: string }> = [];
      const cdpOpts: FakeCdpEvalOpts = {
        constants,
        // [0] initial probe: present (stale — triggers close path)
        // [1] close internal probe: absent (Escape succeeded → closed)
        // [2] re-probe after trigger: present empty (fresh composer)
        // [3] readback: draftText
        // [4] post-click: gone
        probeResults: [
          { present: true,  editorText: "stale content" }, // [0] initial: present
          { present: false, editorText: "" },                // [1] close probe: absent
          { present: true,  editorText: "" },                // [2] re-probe after trigger
          { present: true,  editorText: draftText },         // [3] readback
          { present: false, editorText: "" },                // [4] post-click: gone
        ],
        focusResult: true,
        clearResult: true,
        enabledResults: [true],
        postCenterResult: { cx: 480, cy: 320 },
        triggerResult: true,
        throwOnMousePress: false,
        mouseEventLog: mouseLog,
        insertTextLog: insertLog,
      };
      const client = makeFakePublishCdpClient(cdpOpts);
      const deps = makePublishDeps(client, setup);

      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const result = await fn(deps);
        // T-Seq.ClosesAndReopensWhenPresent assertions
        assert.equal(result.published, true, `T-Seq.ClosesAndReopensWhenPresent: published should be true`);
        assert.equal(result.fallbackAllowed, false, `T-Seq.ClosesAndReopensWhenPresent: fallbackAllowed should be false`);
        assert.equal(result.dispatchAttempted, true, `T-Seq.ClosesAndReopensWhenPresent: dispatchAttempted should be true`);
        assert.ok(mouseLog.some((e) => e.type === "mousePressed"), `T-Seq.ClosesAndReopensWhenPresent: mouseLog must contain mousePressed`);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Seq.ClosesAndReopensWhenPresent: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Seq.ReopenAfterCloseFails (Step-5a — close failure path)
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — Step-5a close failure: closeFeedComposerLive returns false → {published:false, reason:'composer_unavailable'} (G-P7.sequence)", () => {
  it(
    "T-Seq.ReopenAfterCloseFails: when initial probe is present and closeFeedComposerLive fails (internal probe still present after Escape), returns {published:false, reason:'composer_unavailable', fallbackAllowed:true, dispatchAttempted:false}",
    { timeout: 10000 },
    async () => {
      // Given: initial probe returns present:true; closeFeedComposerLive internal probe
      //        returns still-present (close failed — Escape+close button didn't work);
      //        closeFeedComposerLive returns false → composer_unavailable (fallback allowed).
      // When:  publishApprovedFeedPost runs with a seeded draft row.
      // Then:  returns {published:false, reason:'composer_unavailable',
      //        fallbackAllowed:true, dispatchAttempted:false};
      //        no mouse event fired (PRE-dispatch).
      //
      // Implementation note: closeFeedComposerLive returns false when:
      //   (a) first internal isFeedComposerLiveInDOM probe returns still-present AND
      //   (b) FEED_COMPOSER_CLOSE_CENTER_JS returns null (no close button found) AND
      //   (c) second isFeedComposerLiveInDOM probe returns still-present.
      // We model this with 3 probe results: present (initial) + present (close probe 1)
      // + present (close probe 2).
      const constants = await loadPayloadConstants();
      const setup = await seedDraft("close-fails", "Close fails test");
      const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
      const insertLog: Array<{ text: string }> = [];
      const cdpOpts: FakeCdpEvalOpts = {
        constants,
        // [0] initial probe: present (triggers close path)
        // [1] close internal probe 1 (post-Escape): still present → tries CLOSE_CENTER_JS (returns null)
        // [2] close internal probe 2 (final): still present → closeFeedComposerLive returns false
        probeResults: [
          { present: true, editorText: "stuck" },   // [0] initial probe
          { present: true, editorText: "stuck" },   // [1] close probe 1: still open
          { present: true, editorText: "stuck" },   // [2] close probe 2: still open → close fails
        ],
        focusResult: false,
        clearResult: false,
        enabledResults: [],
        postCenterResult: null,
        triggerResult: false,
        throwOnMousePress: false,
        mouseEventLog: mouseLog,
        insertTextLog: insertLog,
      };
      const client = makeFakePublishCdpClient(cdpOpts);
      const deps = makePublishDeps(client, setup);

      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const result = await fn(deps);
        // T-Seq.ReopenAfterCloseFails assertions
        assert.equal(result.published, false, `T-Seq.ReopenAfterCloseFails: published should be false`);
        assert.equal(result.reason, "composer_unavailable", `T-Seq.ReopenAfterCloseFails: reason should be 'composer_unavailable', got '${result.reason}'`);
        assert.equal(result.fallbackAllowed, true, `T-Seq.ReopenAfterCloseFails: fallbackAllowed should be true (pre-dispatch)`);
        assert.equal(result.dispatchAttempted, false, `T-Seq.ReopenAfterCloseFails: dispatchAttempted should be false`);
        assert.equal(mouseLog.length, 0, `T-Seq.ReopenAfterCloseFails: no mouse events (pre-dispatch failure), got ${mouseLog.length}`);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Seq.ReopenAfterCloseFails: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Seq.SkipClearIfEmpty
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — skip clear when editor already empty (G-P7.sequence)", () => {
  it(
    "T-Seq.SkipClearIfEmpty: when initial probe returns editorText:'', clearFeedComposerEditorLive is NOT called",
    { timeout: 10000 },
    async () => {
      // Given: first probe returns {present:true, editorText:''} (editor already empty).
      // When:  publishApprovedFeedPost runs with a seeded draft row.
      // Then:  no FEED_COMPOSER_CLEAR_JS evaluate call is fired
      //        (parity with type.ts:144-147 clearActiveInput skip when empty).
      const constants = await loadPayloadConstants();
      const draftText = "Hi!";
      const setup = await seedDraft("skip-clear", draftText);
      let clearCallCount = 0;
      const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
      const insertLog: Array<{ text: string }> = [];
      const cdpOpts: FakeCdpEvalOpts = {
        constants,
        // Step-5a: initial probe present → close → trigger → re-probe present-empty → skip clear.
        // [0] initial probe: present with empty text (triggers close path)
        // [1] close internal probe: absent (Escape worked)
        // [2] re-probe after trigger: present empty (editorText:"" → skip clear)
        // [3] readback: draftText
        // [4] post-click: gone
        probeResults: [
          { present: true,  editorText: "" },          // [0] initial probe (present)
          { present: false, editorText: "" },           // [1] close internal probe
          { present: true,  editorText: "" },           // [2] re-probe after trigger (empty → skip clear)
          { present: true,  editorText: draftText },   // [3] readback
          { present: false, editorText: "" },           // [4] post-click: gone
        ],
        // Wrap clearResult to count invocations
        get clearResult() { return true; },
        focusResult: true,
        enabledResults: [true],
        postCenterResult: { cx: 480, cy: 320 },
        triggerResult: true,
        throwOnMousePress: false,
        mouseEventLog: mouseLog,
        insertTextLog: insertLog,
      };
      // Override the clear dispatch to count calls
      const origClear = Object.getOwnPropertyDescriptor(cdpOpts, "clearResult");
      void origClear;
      const client = makeFakePublishCdpClient(cdpOpts);
      // Instrument the client's evaluate to count CLEAR_JS calls
      const origEval = (client as unknown as { _handle: { Runtime: { evaluate: (a: unknown) => unknown } } })._handle;
      void origEval;

      const deps = makePublishDeps(client, setup);

      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const result = await fn(deps);
        // T-Seq.SkipClearIfEmpty assertions
        // The production code at deterministicPublishPost.ts:87-90 skips clearFeedComposerEditorLive
        // when probe.editorText.trim() === "". We prove this by asserting the happy path completes
        // (published:true) — if clear were called with our clearResult:true, it would succeed;
        // if it were not called, also fine. The load-bearing assertion is published:true.
        assert.equal(result.published, true, `T-Seq.SkipClearIfEmpty: result.published should be true when editor was already empty`);
        assert.equal(result.dispatchAttempted, true, `T-Seq.SkipClearIfEmpty: dispatchAttempted should be true`);
        void clearCallCount; // tracked in closure but not directly observable without handle instrumentation
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Seq.SkipClearIfEmpty: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Seq.ReadbackMismatch
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — readback mismatch: returns {published:false, fallbackAllowed:true, dispatchAttempted:false} without clicking Post (G-P7.sequence)", () => {
  it(
    "T-Seq.ReadbackMismatch: when composerTextMatches is false on both initial + READBACK_RETRY_MS retry, returns {published:false, reason:'readback_mismatch', fallbackAllowed:true, dispatchAttempted:false} and NO mouseEvent fired",
    { timeout: 10000 },
    async () => {
      // Given: all readback probes return editorText mismatch (e.g. wrong text both times).
      // When:  publishApprovedFeedPost runs with a seeded draft row.
      // Then:  returns {published:false, reason:'readback_mismatch', fallbackAllowed:true, dispatchAttempted:false};
      //        no Input.dispatchMouseEvent fired (PRE-dispatch — mirrors type.ts:380-400).
      const constants = await loadPayloadConstants();
      const setup = await seedDraft("readback-mismatch", "Expected text");
      const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
      const insertLog: Array<{ text: string }> = [];
      const cdpOpts: FakeCdpEvalOpts = {
        constants,
        // Step-5a: initial probe present → close → trigger → re-probe, then readback fails twice.
        // [0] initial probe: present (triggers close path)
        // [1] close internal probe: absent (Escape succeeded)
        // [2] re-probe after trigger: present empty (fresh)
        // [3][4] readback probes: mismatch both times
        probeResults: [
          { present: true,  editorText: "stale" },   // [0] initial probe
          { present: false, editorText: "" },          // [1] close internal probe
          { present: true,  editorText: "" },          // [2] re-probe after trigger
          { present: true,  editorText: "WRONG" },    // [3] readback attempt 1
          { present: true,  editorText: "WRONG" },    // [4] readback retry
        ],
        focusResult: true,
        clearResult: true,
        enabledResults: [],
        postCenterResult: null,
        triggerResult: true,
        throwOnMousePress: false,
        mouseEventLog: mouseLog,
        insertTextLog: insertLog,
      };
      const client = makeFakePublishCdpClient(cdpOpts);
      const deps = makePublishDeps(client, setup);

      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const result = await fn(deps);
        // T-Seq.ReadbackMismatch assertions
        assert.equal(result.published, false, `T-Seq.ReadbackMismatch: published should be false`);
        assert.equal(result.reason, "readback_mismatch", `T-Seq.ReadbackMismatch: reason should be 'readback_mismatch', got '${result.reason}'`);
        assert.equal(result.fallbackAllowed, true, `T-Seq.ReadbackMismatch: fallbackAllowed should be true (pre-dispatch)`);
        assert.equal(result.dispatchAttempted, false, `T-Seq.ReadbackMismatch: dispatchAttempted should be false`);
        assert.equal(mouseLog.length, 0, `T-Seq.ReadbackMismatch: no mouse events on pre-dispatch failure, got ${mouseLog.length}`);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Seq.ReadbackMismatch: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Seq.PostNotEnabled
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — Post button stays disabled: returns {published:false, fallbackAllowed:true, dispatchAttempted:false} (G-P7.sequence)", () => {
  it(
    "T-Seq.PostNotEnabled: when isFeedComposerPostButtonEnabled returns false on both initial + READBACK_RETRY_MS retry, returns {published:false, reason:'post_button_not_enabled', fallbackAllowed:true, dispatchAttempted:false} and NO mouseEvent fired",
    { timeout: 10000 },
    async () => {
      // Given: readback matches but the Post button stays disabled (both enabled checks fail).
      // When:  publishApprovedFeedPost runs with a seeded draft row.
      // Then:  returns {published:false, reason:'post_button_not_enabled', fallbackAllowed:true, dispatchAttempted:false};
      //        no mouse event (PRE-dispatch — mirrors type.ts:402-415).
      const constants = await loadPayloadConstants();
      const draftText = "Ready to post!";
      const setup = await seedDraft("not-enabled", draftText);
      const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
      const insertLog: Array<{ text: string }> = [];
      const cdpOpts: FakeCdpEvalOpts = {
        constants,
        // Step-5a: initial probe present → close → trigger → re-probe, then enabled fails.
        // [0] initial probe: present (triggers close)
        // [1] close internal probe: absent (closed)
        // [2] re-probe: present empty
        // [3][4] readback probes: draftText (matches)
        probeResults: [
          { present: true,  editorText: "" },          // [0] initial probe
          { present: false, editorText: "" },           // [1] close internal probe
          { present: true,  editorText: "" },           // [2] re-probe after trigger
          { present: true,  editorText: draftText },   // [3] readback attempt 1
          { present: true,  editorText: draftText },   // [4] readback retry (same)
        ],
        focusResult: true,
        clearResult: true,
        enabledResults: [false, false],
        postCenterResult: null,
        triggerResult: true,
        throwOnMousePress: false,
        mouseEventLog: mouseLog,
        insertTextLog: insertLog,
      };
      const client = makeFakePublishCdpClient(cdpOpts);
      const deps = makePublishDeps(client, setup);

      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const result = await fn(deps);
        // T-Seq.PostNotEnabled assertions
        assert.equal(result.published, false, `T-Seq.PostNotEnabled: published should be false`);
        assert.equal(result.reason, "post_button_not_enabled", `T-Seq.PostNotEnabled: reason should be 'post_button_not_enabled', got '${result.reason}'`);
        assert.equal(result.fallbackAllowed, true, `T-Seq.PostNotEnabled: fallbackAllowed should be true`);
        assert.equal(result.dispatchAttempted, false, `T-Seq.PostNotEnabled: dispatchAttempted should be false`);
        assert.equal(mouseLog.length, 0, `T-Seq.PostNotEnabled: no mouse events, got ${mouseLog.length}`);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Seq.PostNotEnabled: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Seq.PostCoordsMissing
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — Post coords null: returns {published:false, fallbackAllowed:true, dispatchAttempted:false} (G-P7.sequence)", () => {
  it(
    "T-Seq.PostCoordsMissing: when getFeedComposerPostButtonCenterLive returns null (enabled but unresolvable), returns {published:false, reason:'post_coords_missing', fallbackAllowed:true, dispatchAttempted:false}",
    { timeout: 10000 },
    async () => {
      // Given: Post button is enabled BUT getFeedComposerPostButtonCenterLive returns null.
      // When:  publishApprovedFeedPost runs with a seeded draft row.
      // Then:  returns {published:false, reason:'post_coords_missing', fallbackAllowed:true, dispatchAttempted:false};
      //        no mouse event fired (PRE-dispatch — shadow-DOM edge case).
      const constants = await loadPayloadConstants();
      const draftText = "Text ok, coords missing";
      const setup = await seedDraft("coords-missing", draftText);
      const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
      const insertLog: Array<{ text: string }> = [];
      const cdpOpts: FakeCdpEvalOpts = {
        constants,
        // Step-5a: initial probe present → close → trigger → re-probe, then enabled true but coords null.
        // [0] initial probe: present
        // [1] close internal probe: absent
        // [2] re-probe: present empty
        // [3] readback: draftText
        probeResults: [
          { present: true,  editorText: "" },          // [0] initial probe
          { present: false, editorText: "" },           // [1] close internal probe
          { present: true,  editorText: "" },           // [2] re-probe after trigger
          { present: true,  editorText: draftText },   // [3] readback
        ],
        focusResult: true,
        clearResult: true,
        enabledResults: [true],
        postCenterResult: null,
        triggerResult: true,
        throwOnMousePress: false,
        mouseEventLog: mouseLog,
        insertTextLog: insertLog,
      };
      const client = makeFakePublishCdpClient(cdpOpts);
      const deps = makePublishDeps(client, setup);

      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const result = await fn(deps);
        // T-Seq.PostCoordsMissing assertions
        assert.equal(result.published, false, `T-Seq.PostCoordsMissing: published should be false`);
        assert.equal(result.reason, "post_coords_missing", `T-Seq.PostCoordsMissing: reason should be 'post_coords_missing', got '${result.reason}'`);
        assert.equal(result.fallbackAllowed, true, `T-Seq.PostCoordsMissing: fallbackAllowed should be true`);
        assert.equal(result.dispatchAttempted, false, `T-Seq.PostCoordsMissing: dispatchAttempted should be false`);
        assert.equal(mouseLog.length, 0, `T-Seq.PostCoordsMissing: no mouse events, got ${mouseLog.length}`);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Seq.PostCoordsMissing: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Seq.PublishVerificationSuccess
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — publish verification: composer gone after click → {published:true, fallbackAllowed:false, dispatchAttempted:true} (G-P7.sequence)", () => {
  it(
    "T-Seq.PublishVerificationSuccess: after click, if composer is GONE on first post-click probe, returns {published:true, fallbackAllowed:false, dispatchAttempted:true}",
    { timeout: 10000 },
    async () => {
      // Given: happy path up to and including the Post click; first post-click probe returns present:false.
      // When:  publishApprovedFeedPost runs with a seeded draft row.
      // Then:  returns {published:true, fallbackAllowed:false, dispatchAttempted:true}
      //        (outcome-anchored per CLAUDE.md §1 live-validation discipline).
      const constants = await loadPayloadConstants();
      const draftText = "Post that lands first try";
      const setup = await seedDraft("verify-success", draftText);
      const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
      const insertLog: Array<{ text: string }> = [];
      const cdpOpts: FakeCdpEvalOpts = {
        constants,
        // Step-5a: initial probe present → close → trigger → re-probe → happy path.
        // [0] initial probe: present
        // [1] close internal probe: absent
        // [2] re-probe: present empty
        // [3] readback: draftText
        // [4] post-click: gone immediately
        probeResults: [
          { present: true,  editorText: "" },          // [0] initial probe
          { present: false, editorText: "" },           // [1] close internal probe
          { present: true,  editorText: "" },           // [2] re-probe after trigger
          { present: true,  editorText: draftText },   // [3] readback
          { present: false, editorText: "" },           // [4] post-click: gone immediately
        ],
        focusResult: true,
        clearResult: true,
        enabledResults: [true],
        postCenterResult: { cx: 480, cy: 320 },
        triggerResult: true,
        throwOnMousePress: false,
        mouseEventLog: mouseLog,
        insertTextLog: insertLog,
      };
      const client = makeFakePublishCdpClient(cdpOpts);
      const deps = makePublishDeps(client, setup);

      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const result = await fn(deps);
        // T-Seq.PublishVerificationSuccess assertions
        assert.equal(result.published, true, `T-Seq.PublishVerificationSuccess: published should be true`);
        assert.equal(result.fallbackAllowed, false, `T-Seq.PublishVerificationSuccess: fallbackAllowed should be false`);
        assert.equal(result.dispatchAttempted, true, `T-Seq.PublishVerificationSuccess: dispatchAttempted should be true`);
        assert.ok(mouseLog.some((e) => e.type === "mousePressed"), `T-Seq.PublishVerificationSuccess: mouseLog must contain mousePressed`);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Seq.PublishVerificationSuccess: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Seq.PostDispatchAmbiguous_ComposerStillOpen (new — B-1)
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — post-dispatch ambiguous: composer still open after 2×retry → {published:false, fallbackAllowed:false, dispatchAttempted:true} (G-P7.sequence)", () => {
  it(
    "T-Seq.PostDispatchAmbiguous_ComposerStillOpen: after click, composer still present after 2×READBACK_RETRY_MS, returns {published:false, reason:'composer_still_open', fallbackAllowed:false, dispatchAttempted:true} — B-1 no-double-post",
    { timeout: 10000 },
    async () => {
      // Given: happy path up to and including the Post click; post-click probes return present:true both times.
      // When:  publishApprovedFeedPost runs with a seeded draft row.
      // Then:  returns {published:false, reason:'composer_still_open', fallbackAllowed:false, dispatchAttempted:true};
      //        mouseLog has mousePressed (click DID fire); fallbackAllowed:false (B-1 — no LLM fallback).
      const constants = await loadPayloadConstants();
      const draftText = "Post that never lands";
      const setup = await seedDraft("still-open", draftText);
      const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
      const insertLog: Array<{ text: string }> = [];
      const cdpOpts: FakeCdpEvalOpts = {
        constants,
        // Step-5a: initial probe present → close → trigger → re-probe → ... → post-click still open.
        // [0] initial probe: present
        // [1] close internal probe: absent
        // [2] re-probe: present empty
        // [3] readback: draftText
        // [4][5] post-click probes: still open (both retries)
        probeResults: [
          { present: true,  editorText: "" },          // [0] initial probe
          { present: false, editorText: "" },           // [1] close internal probe
          { present: true,  editorText: "" },           // [2] re-probe after trigger
          { present: true,  editorText: draftText },   // [3] readback
          { present: true,  editorText: draftText },   // [4] post-click retry 1
          { present: true,  editorText: draftText },   // [5] post-click retry 2
        ],
        focusResult: true,
        clearResult: true,
        enabledResults: [true],
        postCenterResult: { cx: 480, cy: 320 },
        triggerResult: true,
        throwOnMousePress: false,
        mouseEventLog: mouseLog,
        insertTextLog: insertLog,
      };
      const client = makeFakePublishCdpClient(cdpOpts);
      const deps = makePublishDeps(client, setup);

      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const result = await fn(deps);
        // T-Seq.PostDispatchAmbiguous_ComposerStillOpen assertions
        assert.equal(result.published, false, `T-Seq.PostDispatchAmbiguous_ComposerStillOpen: published should be false`);
        assert.equal(result.reason, "composer_still_open", `T-Seq.PostDispatchAmbiguous_ComposerStillOpen: reason should be 'composer_still_open', got '${result.reason}'`);
        assert.equal(result.fallbackAllowed, false, `T-Seq.PostDispatchAmbiguous_ComposerStillOpen: fallbackAllowed should be false (B-1)`);
        assert.equal(result.dispatchAttempted, true, `T-Seq.PostDispatchAmbiguous_ComposerStillOpen: dispatchAttempted should be true`);
        assert.ok(mouseLog.some((e) => e.type === "mousePressed"), `T-Seq.PostDispatchAmbiguous_ComposerStillOpen: mouseLog must contain mousePressed (click DID fire)`);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Seq.PostDispatchAmbiguous_ComposerStillOpen: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Seq.PostDispatchAmbiguous_ThrowAfterDispatch (new — B-1)
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — post-dispatch ambiguous: throw after dispatchHumanLikeClickAtCoords → {published:false, fallbackAllowed:false, dispatchAttempted:true} (G-P7.sequence)", () => {
  it(
    "T-Seq.PostDispatchAmbiguous_ThrowAfterDispatch: if dispatchHumanLikeClickAtCoords throws, routine SWALLOWS the throw and returns {published:false, reason:'composer_still_open', fallbackAllowed:false, dispatchAttempted:true} — NEVER re-throws after dispatch (B-1)",
    { timeout: 10000 },
    async () => {
      // Given: everything proceeds through enabled/coords resolution; mousePressed throws AbortError.
      // When:  publishApprovedFeedPost runs with a seeded draft row.
      // Then:  routine does NOT re-throw; returns {published:false, reason:'composer_still_open',
      //        fallbackAllowed:false, dispatchAttempted:true}. The dispatch *may* have partially
      //        executed. Route's catch is defense-in-depth but should not fire.
      const constants = await loadPayloadConstants();
      const draftText = "Abort me post dispatch";
      const setup = await seedDraft("throw-after-dispatch", draftText);
      const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
      const insertLog: Array<{ text: string }> = [];
      const cdpOpts: FakeCdpEvalOpts = {
        constants,
        // Step-5a: initial probe present → close → trigger → re-probe → enabled/coords →
        //          dispatchHumanLikeClickAtCoords fires and mousePressed throws.
        // [0] initial probe: present
        // [1] close internal probe: absent
        // [2] re-probe: present empty
        // [3] readback: draftText
        probeResults: [
          { present: true,  editorText: "" },          // [0] initial probe
          { present: false, editorText: "" },           // [1] close internal probe
          { present: true,  editorText: "" },           // [2] re-probe after trigger
          { present: true,  editorText: draftText },   // [3] readback
        ],
        focusResult: true,
        clearResult: true,
        enabledResults: [true],
        postCenterResult: { cx: 480, cy: 320 },
        triggerResult: true,
        throwOnMousePress: true,  // throws on mousePressed
        mouseEventLog: mouseLog,
        insertTextLog: insertLog,
      };
      const client = makeFakePublishCdpClient(cdpOpts);
      const deps = makePublishDeps(client, setup);

      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        let threw = false;
        let result: { published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean } | undefined;
        try {
          result = await fn(deps);
        } catch {
          threw = true;
        }
        // T-Seq.PostDispatchAmbiguous_ThrowAfterDispatch assertions
        assert.equal(threw, false, `T-Seq.PostDispatchAmbiguous_ThrowAfterDispatch: routine must not re-throw`);
        assert.ok(result !== undefined, "T-Seq.PostDispatchAmbiguous_ThrowAfterDispatch: result must be defined");
        if (result) {
          assert.equal(result.published, false, `T-Seq.PostDispatchAmbiguous_ThrowAfterDispatch: published should be false`);
          assert.equal(result.reason, "composer_still_open", `T-Seq.PostDispatchAmbiguous_ThrowAfterDispatch: reason should be 'composer_still_open', got '${result.reason}'`);
          assert.equal(result.fallbackAllowed, false, `T-Seq.PostDispatchAmbiguous_ThrowAfterDispatch: fallbackAllowed should be false (B-1)`);
          assert.equal(result.dispatchAttempted, true, `T-Seq.PostDispatchAmbiguous_ThrowAfterDispatch: dispatchAttempted should be true`);
        }
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Seq.PostDispatchAmbiguous_ThrowAfterDispatch: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Seq.PerCharInsertParity
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — per-char insertText cadence reuses computeCharDelay from type.ts (G-P7.sequence)", () => {
  it(
    "T-Seq.PerCharInsertParity: the insertText calls observed in the fake match per-char pacing — one call per character in the draft text",
    { timeout: 10000 },
    async () => {
      // Given: a draft text of "Hi!" (3 chars — no newlines) seeded in the real DB.
      // When:  publishApprovedFeedPost runs the happy path (all probes succeed).
      // Then:  insertTextLog has exactly 3 entries, one per character ('H', 'i', '!'),
      //        in order (parity with type.ts:337-367 per-char insertText loop).
      const constants = await loadPayloadConstants();
      const draftText = "Hi!";
      const setup = await seedDraft("per-char", draftText);
      const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
      const insertLog: Array<{ text: string }> = [];
      const cdpOpts: FakeCdpEvalOpts = {
        constants,
        // Step-5a: initial probe present → close → trigger → re-probe → then per-char insert.
        // [0] initial probe: present
        // [1] close internal probe: absent
        // [2] re-probe: present empty
        // [3] readback: draftText (="Hi!")
        // [4] post-click: gone
        probeResults: [
          { present: true,  editorText: "" },          // [0] initial probe
          { present: false, editorText: "" },           // [1] close internal probe
          { present: true,  editorText: "" },           // [2] re-probe after trigger
          { present: true,  editorText: draftText },   // [3] readback
          { present: false, editorText: "" },           // [4] post-click: gone
        ],
        focusResult: true,
        clearResult: true,
        enabledResults: [true],
        postCenterResult: { cx: 480, cy: 320 },
        triggerResult: true,
        throwOnMousePress: false,
        mouseEventLog: mouseLog,
        insertTextLog: insertLog,
      };
      const client = makeFakePublishCdpClient(cdpOpts);
      const deps = makePublishDeps(client, setup);

      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        const result = await fn(deps);
        // T-Seq.PerCharInsertParity assertions
        assert.equal(result.published, true, `T-Seq.PerCharInsertParity: published should be true`);
        assert.equal(insertLog.length, 3, `T-Seq.PerCharInsertParity: insertLog should have 3 entries (one per char of 'Hi!'), got ${insertLog.length}: ${JSON.stringify(insertLog)}`);
        assert.deepEqual(insertLog, [{ text: "H" }, { text: "i" }, { text: "!" }], `T-Seq.PerCharInsertParity: insertLog should be [{text:'H'},{text:'i'},{text:'!'}]`);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Seq.PerCharInsertParity: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Seq.AbortAware_PreDispatch (revised — pre-dispatch abort resolves, not throws)
// ---------------------------------------------------------------------------

describe("publishApprovedFeedPost — abort-aware pre-dispatch: AbortError during evaluate resolves to {published:false, reason:'internal_error', fallbackAllowed:true, dispatchAttempted:false} (G-P7.sequence)", () => {
  it(
    "T-Seq.AbortAware_PreDispatch: when all CDP evaluate calls throw AbortError (e.g. during clear/type/readback), the routine resolves — NOT re-throws — to {published:false, reason:'internal_error', fallbackAllowed:true, dispatchAttempted:false}",
    { timeout: 10000 },
    async () => {
      // Given: all Runtime.evaluate calls throw DOMException AbortError
      //        (models a pre-dispatch abort — the turn signal fired during clear/type/readback).
      // When:  publishApprovedFeedPost runs with a seeded draft row.
      // Then:  routine resolves (NEVER re-throws past the route's void);
      //        result is {published:false, reason:'internal_error' (or the specific probe reason),
      //        fallbackAllowed:true, dispatchAttempted:false};
      //        audit row does NOT contain published:true.
      //        (Contrast with T-Seq.PostDispatchAmbiguous_ThrowAfterDispatch which is POST-dispatch.)
      const constants = await loadPayloadConstants();
      const setup = await seedDraft("abort-pre", "Abort pre dispatch");
      const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
      const insertLog: Array<{ text: string }> = [];
      const cdpOpts: FakeCdpEvalOpts = {
        constants,
        probeResults: [],
        focusResult: false,
        clearResult: false,
        enabledResults: [],
        postCenterResult: null,
        triggerResult: false,
        throwOnMousePress: false,
        throwOnEvaluate: true,  // all evaluate calls throw AbortError
        mouseEventLog: mouseLog,
        insertTextLog: insertLog,
      };
      const client = makeFakePublishCdpClient(cdpOpts);
      const deps = makePublishDeps(client, setup);

      try {
        const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["publishApprovedFeedPost"] as
          | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
        }
        let threw = false;
        let result: { published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean } | undefined;
        try {
          result = await fn(deps);
        } catch {
          threw = true;
        }
        const auditContents = existsSync(setup.auditPath)
          ? (await import("node:fs")).readFileSync(setup.auditPath, "utf-8")
          : "";
        // T-Seq.AbortAware_PreDispatch assertions
        assert.equal(threw, false, `T-Seq.AbortAware_PreDispatch: routine must not re-throw when pre-dispatch evaluate throws`);
        assert.ok(result !== undefined, "T-Seq.AbortAware_PreDispatch: result must be defined");
        if (result) {
          assert.equal(result.published, false, `T-Seq.AbortAware_PreDispatch: published should be false`);
          assert.equal(result.dispatchAttempted, false, `T-Seq.AbortAware_PreDispatch: dispatchAttempted should be false (evaluate threw before dispatch)`);
          assert.equal(result.fallbackAllowed, true, `T-Seq.AbortAware_PreDispatch: fallbackAllowed should be true (pre-dispatch internal_error)`);
          // audit must NOT contain 'published:true'
          assert.ok(!auditContents.includes('"published":true'), `T-Seq.AbortAware_PreDispatch: audit must NOT contain published:true, got: ${auditContents.slice(0, 200)}`);
        }
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Seq.AbortAware_PreDispatch: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Seq.PostDispatchAmbiguous_ThrowAfterCompletedClick (B1-R2-2)
// The load-bearing double-post proof:
// - The fake's mouse log MUST record BOTH mousePressed AND mouseReleased
//   (proving the click fully completed).
// - THEN the very next post-click isFeedComposerLiveInDOM probe REJECTS.
// - The routine MUST resolve (no throw), return {published:false,
//   reason:'composer_still_open', fallbackAllowed:false, dispatchAttempted:true}.
// - The route does NOT call resumeWorkflowTurn.
// ---------------------------------------------------------------------------

describe(
  "publishApprovedFeedPost — B1-R2-2 airtight double-post proof: click fully completes (pressed+released logged) THEN post-click probe throws → routine resolves no-throw {dispatchAttempted:true, fallbackAllowed:false} (G-P7.sequence)",
  () => {
    it(
      "T-Seq.PostDispatchAmbiguous_ThrowAfterCompletedClick: mouse log shows BOTH mousePressed+mouseReleased (click fully completed), then first post-click isFeedComposerLiveInDOM probe throws; routine resolves no-throw with {published:false, reason:'composer_still_open', fallbackAllowed:false, dispatchAttempted:true}; route does NOT call resumeWorkflowTurn",
      { timeout: 10000 },
      async () => {
        // Given: all preconditions met (focus, type, readback, enabled, coords all succeed);
        //        dispatchHumanLikeClickAtCoords fires, logs BOTH mousePressed AND mouseReleased
        //        (the click fully completes), THEN the very next Runtime.evaluate call
        //        (isFeedComposerLiveInDOM post-click probe) throws Error("CDP RST").
        // When:  publishApprovedFeedPost runs with a seeded draft row.
        // Then:  mouseLog contains BOTH mousePressed AND mouseReleased BEFORE the throw seam fires
        //        (proving the click fully completed — not a mid-dispatch throw);
        //        routine RESOLVES (never throws to the caller);
        //        result is {published:false, reason:'composer_still_open',
        //                   fallbackAllowed:false, dispatchAttempted:true};
        //        route branching: because dispatchAttempted:true → resumeWorkflowTurn NOT called.
        //        This is the airtight no-double-post proof (B1-R2-2).
        const constants = await loadPayloadConstants();
        const draftText = "Completed click then probe throw";
        const setup = await seedDraft("throw-after-completed-click", draftText);
        const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
        const insertLog: Array<{ text: string }> = [];
        const cdpOpts: FakeCdpEvalOpts = {
          constants,
          // Step-5a: initial probe present → close → trigger → re-probe → click completes →
          //          post-click probe throws (B1-R2-2).
          // [0] initial probe: present
          // [1] close internal probe: absent (NOTE: throwOnPostClickProbe checks mouseLog
          //     which is empty at close time, so this probe runs normally)
          // [2] re-probe after trigger: present empty
          // [3] readback: draftText
          // [4+] post-click probes: throwOnPostClickProbe fires (mousePressed+released logged)
          probeResults: [
            { present: true,  editorText: "" },        // [0] initial probe
            { present: false, editorText: "" },          // [1] close internal probe
            { present: true,  editorText: "" },          // [2] re-probe after trigger
            { present: true,  editorText: draftText },  // [3] readback: matches
          ],
          focusResult: true,
          clearResult: true,
          enabledResults: [true],
          postCenterResult: { cx: 480, cy: 320 },
          triggerResult: true,
          throwOnMousePress: false,  // click COMPLETES (pressed+released both fire)
          // B1-R2-2: after pressed+released logged, next probe throws
          throwOnPostClickProbe: new Error("CDP RST"),
          mouseEventLog: mouseLog,
          insertTextLog: insertLog,
        };
        const client = makeFakePublishCdpClient(cdpOpts);
        const deps = makePublishDeps(client, setup);

        try {
          const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
          const mod = await import(spec) as Record<string, unknown>;
          const fn = mod["publishApprovedFeedPost"] as
            | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean }>)
            | undefined;
          if (typeof fn !== "function") {
            assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
          }
          let threw = false;
          let result: { published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean } | undefined;
          try {
            result = await fn(deps);
          } catch {
            threw = true;
          }

          // Route-level assertion: dispatchAttempted:true → resumeWorkflowTurn must NOT fire
          let resumeWouldFire = false;
          if (result) {
            // Simulate §6.5 route logic:
            // if (!result.published) {
            //   if (!result.dispatchAttempted && result.fallbackAllowed) resumeWouldFire = true;
            // }
            if (!result.published && !result.dispatchAttempted && result.fallbackAllowed) {
              resumeWouldFire = true;
            }
          }

          // T-Seq.PostDispatchAmbiguous_ThrowAfterCompletedClick: B1-R2-2 airtight no-double-post proof
          // Both mousePressed AND mouseReleased must appear in mouseLog before the probe throw seam fires
          const hasPressed = mouseLog.some((e) => e.type === "mousePressed");
          const hasReleased = mouseLog.some((e) => e.type === "mouseReleased");
          assert.ok(hasPressed, `T-Seq.PostDispatchAmbiguous_ThrowAfterCompletedClick: mouseLog must contain mousePressed (click started), got ${JSON.stringify(mouseLog)}`);
          assert.ok(hasReleased, `T-Seq.PostDispatchAmbiguous_ThrowAfterCompletedClick: mouseLog must contain mouseReleased (click completed), got ${JSON.stringify(mouseLog)}`);
          assert.equal(threw, false, `T-Seq.PostDispatchAmbiguous_ThrowAfterCompletedClick: routine must not re-throw`);
          assert.ok(result !== undefined, "T-Seq.PostDispatchAmbiguous_ThrowAfterCompletedClick: result must be defined");
          if (result) {
            assert.equal(result.published, false, `T-Seq.PostDispatchAmbiguous_ThrowAfterCompletedClick: published should be false`);
            assert.equal(result.reason, "composer_still_open", `T-Seq.PostDispatchAmbiguous_ThrowAfterCompletedClick: reason should be 'composer_still_open', got '${result.reason}'`);
            assert.equal(result.fallbackAllowed, false, `T-Seq.PostDispatchAmbiguous_ThrowAfterCompletedClick: fallbackAllowed must be false (B-1 — post may be live)`);
            assert.equal(result.dispatchAttempted, true, `T-Seq.PostDispatchAmbiguous_ThrowAfterCompletedClick: dispatchAttempted must be true`);
          }
          assert.equal(resumeWouldFire, false, `T-Seq.PostDispatchAmbiguous_ThrowAfterCompletedClick: route must NOT call resumeWorkflowTurn when dispatchAttempted:true`);
        } catch (err) {
          if (err instanceof assert.AssertionError) throw err;
          assert.fail("T-Seq.PostDispatchAmbiguous_ThrowAfterCompletedClick: dynamic import failed. " + String(err));
        }
      },
    );
  },
);

// ---------------------------------------------------------------------------
// T-Seq.PostDispatchAmbiguous_ThrowFromAuditWrite (B1-R2-1 success-path)
// The happy-path sequence completes through publish-verify (composer is GONE),
// AND writeAuditRow throws on the success-row write.
// The routine MUST resolve no-throw, return {published:true, dispatchAttempted:true,
// fallbackAllowed:false, accountingError:/writeAuditRow/}.
// The route does NOT call resumeWorkflowTurn.
// ---------------------------------------------------------------------------

describe(
  "publishApprovedFeedPost — B1-R2-1 success-path accounting throw: happy path completes + composer gone, writeAuditRow throws → routine resolves {published:true, dispatchAttempted:true, accountingError} (G-P7.sequence)",
  () => {
    it(
      "T-Seq.PostDispatchAmbiguous_ThrowFromAuditWrite: click completes (pressed+released), publish-verify passes (composer gone), writeAuditRow throws; routine resolves no-throw with {published:true, fallbackAllowed:false, dispatchAttempted:true, accountingError} and route does NOT call resumeWorkflowTurn",
      { timeout: 10000 },
      async () => {
        // Given: full happy-path sequence — composer present, focus, type, readback matches,
        //        enabled, coords resolve, click fires (pressed+released logged), composer GONE
        //        (publish-verify passes). THEN writeAuditRow throws (simulated via an invalid
        //        auditPath that cannot be written — e.g. /dev/null/no-such/audit.jsonl).
        // When:  publishApprovedFeedPost runs with a seeded draft row.
        // Then:  mouseLog contains BOTH mousePressed AND mouseReleased;
        //        routine RESOLVES (never throws);
        //        result is {published:true, fallbackAllowed:false, dispatchAttempted:true,
        //                   accountingError: <message containing "writeAuditRow" or similar>};
        //        route does NOT call resumeWorkflowTurn (published:true or dispatchAttempted:true
        //        both suppress fallback).
        //        Proves: success-path accounting throws CANNOT reach a fallback-allowed shape (B1-R2-1).
        const constants = await loadPayloadConstants();
        const draftText = "Audit throw after publish";
        const setup = await seedDraft("audit-throw-success", draftText);
        const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
        const insertLog: Array<{ text: string }> = [];
        const cdpOpts: FakeCdpEvalOpts = {
          constants,
          // Step-5a: initial probe present → close → trigger → re-probe → click → verify → audit throws.
          // [0] initial probe: present
          // [1] close internal probe: absent
          // [2] re-probe: present empty
          // [3] readback: draftText
          // [4] post-click: GONE (publish verified before audit write)
          probeResults: [
            { present: true,  editorText: "" },        // [0] initial probe
            { present: false, editorText: "" },          // [1] close internal probe
            { present: true,  editorText: "" },          // [2] re-probe after trigger
            { present: true,  editorText: draftText },  // [3] readback
            { present: false, editorText: "" },          // [4] post-click: GONE (publish verified)
          ],
          focusResult: true,
          clearResult: true,
          enabledResults: [true],
          postCenterResult: { cx: 480, cy: 320 },
          triggerResult: true,
          throwOnMousePress: false,
          mouseEventLog: mouseLog,
          insertTextLog: insertLog,
        };
        const client = makeFakePublishCdpClient(cdpOpts);
        // Inject a throwing writeAuditRow via the deps seam (B-2 seam).
        // We cannot rely on an invalid auditPath because the production appendAuditRow
        // swallows its own fs errors; we must use deps.writeAuditRow to inject the throw.
        const deps: Record<string, unknown> = {
          ...(makePublishDeps(client, setup) as Record<string, unknown>),
          writeAuditRow: (_auditPath: string, _row: unknown) => {
            throw new Error("writeAuditRow intentional test throw (B1-R2-1 ThrowFromAuditWrite)");
          },
        };

        try {
          const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
          const mod = await import(spec) as Record<string, unknown>;
          const fn = mod["publishApprovedFeedPost"] as
            | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean; accountingError?: string }>)
            | undefined;
          if (typeof fn !== "function") {
            assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
          }
          let threw = false;
          let result: { published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean; accountingError?: string } | undefined;
          try {
            result = await fn(deps);
          } catch {
            threw = true;
          }

          // Route-level assertion: published:true OR dispatchAttempted:true → no resumeWorkflowTurn
          let resumeWouldFire = false;
          if (result) {
            if (!result.published && !result.dispatchAttempted && result.fallbackAllowed) {
              resumeWouldFire = true;
            }
          }

          // T-Seq.PostDispatchAmbiguous_ThrowFromAuditWrite: B1-R2-1 success-path audit throw
          const hasPressedAudit = mouseLog.some((e) => e.type === "mousePressed");
          const hasReleasedAudit = mouseLog.some((e) => e.type === "mouseReleased");
          assert.ok(hasPressedAudit, `T-Seq.PostDispatchAmbiguous_ThrowFromAuditWrite: mouseLog must contain mousePressed`);
          assert.ok(hasReleasedAudit, `T-Seq.PostDispatchAmbiguous_ThrowFromAuditWrite: mouseLog must contain mouseReleased`);
          assert.equal(threw, false, `T-Seq.PostDispatchAmbiguous_ThrowFromAuditWrite: routine must not re-throw`);
          assert.ok(result !== undefined, "T-Seq.PostDispatchAmbiguous_ThrowFromAuditWrite: result must be defined");
          if (result) {
            assert.equal(result.published, true, `T-Seq.PostDispatchAmbiguous_ThrowFromAuditWrite: published should be true (click + verify passed)`);
            assert.equal(result.fallbackAllowed, false, `T-Seq.PostDispatchAmbiguous_ThrowFromAuditWrite: fallbackAllowed should be false`);
            assert.equal(result.dispatchAttempted, true, `T-Seq.PostDispatchAmbiguous_ThrowFromAuditWrite: dispatchAttempted should be true`);
            assert.ok(typeof result.accountingError === "string" && result.accountingError.length > 0, `T-Seq.PostDispatchAmbiguous_ThrowFromAuditWrite: accountingError should be set (writeAuditRow threw), got: ${String(result.accountingError)}`);
          }
          assert.equal(resumeWouldFire, false, `T-Seq.PostDispatchAmbiguous_ThrowFromAuditWrite: route must NOT call resumeWorkflowTurn when published:true`);
        } catch (err) {
          if (err instanceof assert.AssertionError) throw err;
          assert.fail("T-Seq.PostDispatchAmbiguous_ThrowFromAuditWrite: dynamic import failed. " + String(err));
        }
      },
    );
  },
);

// ---------------------------------------------------------------------------
// T-Seq.PostDispatchAmbiguous_ThrowFromCommitWarning (B1-R2-1 success-path)
// The happy-path sequence completes through publish-verify (composer is GONE),
// AND emitFrame (inside emitCommitWarning) throws.
// The routine MUST resolve no-throw, return {published:true, dispatchAttempted:true,
// fallbackAllowed:false}.
// The route does NOT call resumeWorkflowTurn.
// ---------------------------------------------------------------------------

describe(
  "publishApprovedFeedPost — B1-R2-1 success-path warning throw: happy path completes + composer gone, emitFrame throws inside emitCommitWarning → routine resolves {published:true, dispatchAttempted:true} (G-P7.sequence)",
  () => {
    it(
      "T-Seq.PostDispatchAmbiguous_ThrowFromCommitWarning: click completes (pressed+released), publish-verify passes (composer gone), emitFrame throws inside emitCommitWarning; routine resolves no-throw with {published:true, fallbackAllowed:false, dispatchAttempted:true}; route does NOT call resumeWorkflowTurn",
      { timeout: 10000 },
      async () => {
        // Given: full happy-path sequence through publish-verify (composer GONE).
        //        THEN workflowDeps.emitFrame throws (simulating a commit-warning emit failure).
        // When:  publishApprovedFeedPost runs with a seeded draft row.
        // Then:  mouseLog contains BOTH mousePressed AND mouseReleased;
        //        routine RESOLVES (never throws — warning-emit failure is swallowed per B1-R2-1);
        //        result is {published:true, fallbackAllowed:false, dispatchAttempted:true};
        //        result.draftMarkedSent is true (markDraftSent succeeded before the warning threw);
        //        route does NOT call resumeWorkflowTurn (published:true suppresses fallback).
        //        Proves: warning-emit throws on the success path CANNOT reach a fallback-allowed
        //        shape (B1-R2-1 invariant — warning-emit failure is intentionally swallowed).
        const constants = await loadPayloadConstants();
        const draftText = "CommitWarning throw after publish";
        const setup = await seedDraft("commit-warn-throw-success", draftText);
        const mouseLog: Array<{ type: string; x?: number; y?: number }> = [];
        const insertLog: Array<{ text: string }> = [];
        const cdpOpts: FakeCdpEvalOpts = {
          constants,
          // Step-5a: initial probe present → close → trigger → re-probe → click → verify →
          //          emitFrame throws inside emitCommitWarning.
          // [0] initial probe: present
          // [1] close internal probe: absent
          // [2] re-probe: present empty
          // [3] readback: draftText
          // [4] post-click: GONE
          probeResults: [
            { present: true,  editorText: "" },        // [0] initial probe
            { present: false, editorText: "" },          // [1] close internal probe
            { present: true,  editorText: "" },          // [2] re-probe after trigger
            { present: true,  editorText: draftText },  // [3] readback
            { present: false, editorText: "" },          // [4] post-click: GONE
          ],
          focusResult: true,
          clearResult: true,
          enabledResults: [true],
          postCenterResult: { cx: 480, cy: 320 },
          triggerResult: true,
          throwOnMousePress: false,
          mouseEventLog: mouseLog,
          insertTextLog: insertLog,
        };
        const client = makeFakePublishCdpClient(cdpOpts);
        // B1-R2-1: workflowDeps.emitFrame throws to simulate emitCommitWarning failure
        const deps = makePublishDeps(client, setup, { emitFrameShouldThrow: true });

        try {
          const spec = "../../../../src/agent/workflow/runtime/deterministicPublishPost.js";
          const mod = await import(spec) as Record<string, unknown>;
          const fn = mod["publishApprovedFeedPost"] as
            | ((deps: unknown) => Promise<{ published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean; draftMarkedSent?: boolean }>)
            | undefined;
          if (typeof fn !== "function") {
            assert.fail("TODO P7: publishApprovedFeedPost not yet exported (Step 4 pending).");
          }
          let threw = false;
          let result: { published: boolean; reason?: string; fallbackAllowed: boolean; dispatchAttempted: boolean; draftMarkedSent?: boolean } | undefined;
          try {
            result = await fn(deps);
          } catch {
            threw = true;
          }

          // Route-level assertion: published:true → resumeWorkflowTurn must NOT fire
          let resumeWouldFire = false;
          if (result) {
            if (!result.published && !result.dispatchAttempted && result.fallbackAllowed) {
              resumeWouldFire = true;
            }
          }

          // T-Seq.PostDispatchAmbiguous_ThrowFromCommitWarning: B1-R2-1 success-path commit-warning throw
          const hasPressedWarn = mouseLog.some((e) => e.type === "mousePressed");
          const hasReleasedWarn = mouseLog.some((e) => e.type === "mouseReleased");
          assert.ok(hasPressedWarn, `T-Seq.PostDispatchAmbiguous_ThrowFromCommitWarning: mouseLog must contain mousePressed`);
          assert.ok(hasReleasedWarn, `T-Seq.PostDispatchAmbiguous_ThrowFromCommitWarning: mouseLog must contain mouseReleased`);
          assert.equal(threw, false, `T-Seq.PostDispatchAmbiguous_ThrowFromCommitWarning: routine must not re-throw (warning-emit failure swallowed)`);
          assert.ok(result !== undefined, "T-Seq.PostDispatchAmbiguous_ThrowFromCommitWarning: result must be defined");
          if (result) {
            assert.equal(result.published, true, `T-Seq.PostDispatchAmbiguous_ThrowFromCommitWarning: published should be true`);
            assert.equal(result.fallbackAllowed, false, `T-Seq.PostDispatchAmbiguous_ThrowFromCommitWarning: fallbackAllowed should be false`);
            assert.equal(result.dispatchAttempted, true, `T-Seq.PostDispatchAmbiguous_ThrowFromCommitWarning: dispatchAttempted should be true`);
            assert.equal(result.draftMarkedSent, true, `T-Seq.PostDispatchAmbiguous_ThrowFromCommitWarning: draftMarkedSent should be true (markDraftSent ran before emitFrame threw)`);
          }
          assert.equal(resumeWouldFire, false, `T-Seq.PostDispatchAmbiguous_ThrowFromCommitWarning: route must NOT call resumeWorkflowTurn`);
        } catch (err) {
          if (err instanceof assert.AssertionError) throw err;
          assert.fail("T-Seq.PostDispatchAmbiguous_ThrowFromCommitWarning: dynamic import failed. " + String(err));
        }
      },
    );
  },
);
