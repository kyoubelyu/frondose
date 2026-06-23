/**
 * P-POST-PUBLISH-2 — T-Ghost.* + T-NoRegression.* + T-ReadBack.* + T-Hardware.* tests.
 * P-POST-PUBLISH-4 — T-Clear.1–.4 (shadow-aware clearActiveInput scaffolds; Step 2 outside-in TDD).
 * P-POST-PUBLISH-4 Step 5a re-validation — assertions updated for Codex Step-5a two-part fix:
 *   Fix 1: clearActiveInput now probes isFeedComposerLiveInDOM BEFORE clearing (beforeClear probe);
 *           if editorText is empty, skips the clear entirely (EDITOR_JS + skip path).
 *   Fix 2: after composerTextMatches succeeds, isFeedComposerPostButtonEnabled is checked
 *           (initial probe + one retry) before returning ok:true.
 *
 * STRICT-EQUAL HARNESS (Step-5 NIT fix — eliminates el.focus() substring fragility):
 *
 * The fake client.evaluate now dispatches by STRICT-EQUAL comparison against the imported
 * constants FEED_COMPOSER_EDITOR_JS, FEED_COMPOSER_FOCUS_JS, FEED_COMPOSER_POST_ENABLED_JS
 * (from composerReadiness.js).
 * REACT_SAFE_CLEAR_ACTIVE_INPUT_JS is file-private in type.ts and cannot be imported —
 * its calls (clearActiveInput) are caught by the fallback "anything else → return false"
 * branch, which matches the real behavior (clearActiveInput returns false on contenteditable
 * and falls through to Cmd+A+Backspace via Input.dispatchKeyEvent, not another evaluate).
 *
 * P-POST-PUBLISH-4 CLEAR_JS EXTENSION:
 *
 * FEED_COMPOSER_CLEAR_JS is exported from composerReadiness.ts (Step 4 added it).
 * The gate-load via dynamic import in before() is retained for forward-compat.
 *
 * UPDATED PAYLOAD-BASED CALL ORDER (feed-composer happy-path, after Step-5a fix):
 *   [EDITOR_JS call 0] Insertion A — pre-loop readiness probe
 *   [FOCUS_JS call 0]  Insertion B — live-DOM focus
 *   [EDITOR_JS call 1] clearActiveInput beforeClear probe — editorText check (NEW: Fix 1)
 *     → if editorText="" skip clear (empty gate — the live-failure regression guard)
 *     → if editorText≠"" dispatch CLEAR_JS (then optionally fall through)
 *   [CLEAR_JS call 0]  shadow-aware clear (only when beforeClear probe found non-empty text)
 *   [OTHER call]       clearActiveInput (REACT_SAFE_CLEAR) — fallback when CLEAR_JS returns false
 *   [EDITOR_JS call 2] Insertion C — post-loop read-back, first probe
 *   [EDITOR_JS call 3] Insertion C — post-loop read-back, second probe (only on present:true mismatch)
 *   [POST_ENABLED_JS]  Fix 2: Post-button-enabled check (initial + retry if needed)
 *
 * Per-payload tracking is robust to any interleaved calls.
 *
 * Runner: node --import tsx --test --experimental-test-module-mocks --test-force-exit
 *         tests/tools/browser/type-composerReadiness.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { before, describe, it } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import {
  FEED_COMPOSER_EDITOR_JS,
  FEED_COMPOSER_FOCUS_JS,
  FEED_COMPOSER_POST_ENABLED_JS,
} from "../../../src/linkedin/composerReadiness.js";

// ---------------------------------------------------------------------------
// P-POST-PUBLISH-4: Gate-on-builder dynamic import for FEED_COMPOSER_CLEAR_JS.
//
// FEED_COMPOSER_CLEAR_JS is NOT exported from composerReadiness.ts until Step 4.
// A static import of a missing named export would cause a TS2307 / runtime ReferenceError.
// Solution: declare the variable here as string | undefined, then attempt to resolve it
// at runtime in before(). This mirrors the profileLock-p58a.mock.test.ts pattern exactly.
// Before Step 4: variable stays undefined → CLEAR_JS dispatch branch uses (expr === undefined)
// which is always false → T-Clear.* tests reach assert.fail("TODO …") → RED on HEAD.
// After Step 4: variable is set to the real constant → branch fires correctly.
// ---------------------------------------------------------------------------
let FEED_COMPOSER_CLEAR_JS_LOADED: string | undefined;

before(async () => {
  try {
    // Non-literal specifier avoids static analysis resolving the missing export at compile time.
    const spec = "../../../src/linkedin/composerReadiness.js";
    const mod = await import(spec) as Record<string, unknown>;
    if (typeof mod["FEED_COMPOSER_CLEAR_JS"] === "string") {
      FEED_COMPOSER_CLEAR_JS_LOADED = mod["FEED_COMPOSER_CLEAR_JS"] as string;
    }
  } catch {
    // composerReadiness.ts exists but FEED_COMPOSER_CLEAR_JS not exported yet (Step 4 pending).
  }
});
import { insertDraft, insertLead, upsertRawCandidate } from "../../../src/persistence/salesDb.js";
import { getSalesDb } from "../../../src/tools/sales/_dbHandle.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/types.js";
import { makeTypeTool } from "../../../src/tools/browser/type.js";
import { cleanupTmpDir } from "../../_helpers/tmp.js";

// Disable pacing for the mock suite.
process.env.FRONDOSE_PACE_MIN_MS = "0";
process.env.FRONDOSE_PACE_MAX_MS = "0";

const abortSignal = new AbortController().signal;
const FAKE_BORDER = [0, 0, 10, 0, 10, 10, 0, 10]; // center x=5, y=5

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/**
 * CDP call log categories:
 *   "insertText:<char>"        — per-char insertText
 *   "key:<type>:<key>:mod<n>" — dispatchKeyEvent
 *   "mouse:<type>:<x>,<y>"   — dispatchMouseEvent
 *
 * STRICT-EQUAL HARNESS (Step-5 NIT fix):
 *
 * evaluate dispatches by expr === FEED_COMPOSER_EDITOR_JS (for editor probe calls)
 * or expr === FEED_COMPOSER_FOCUS_JS (for focus calls). Anything else returns false.
 *
 * Per-payload tracking:
 *   editorJsCallLog  — entries for each FEED_COMPOSER_EDITOR_JS call
 *   focusJsCallLog   — entries for each FEED_COMPOSER_FOCUS_JS call
 *   otherJsCallLog   — entries for all other evaluate calls (REACT_SAFE_CLEAR, etc.)
 *   callLogAll       — all evaluate expressions (debug)
 *
 * Queue for editor: editorJsQueue — ordered array of JSON-encoded strings.
 *   Each FEED_COMPOSER_EDITOR_JS call drains the next entry.
 *   Exhausted queue → default {present:false, editorText:""}.
 *
 * focusJsResult: boolean — returned for every FEED_COMPOSER_FOCUS_JS call.
 *
 * editorJsShouldThrowAfterN: throw on the N-th EDITOR_JS call (0-indexed).
 */
type CallLogEntry = string;

/**
 * Seed a temp sales.sqlite under a fresh tmp dir so latestDraftTextForCurrentLead returns
 * a known draft text for the given profile slug. Sets FRONDOSE_HOME_BASE to the tmp dir.
 * Returns the tmp dir path for cleanup in finally blocks.
 */
function seedSalesDb(slug: string, draftText: string): string {
  const home = mkdtempSync(pathJoin(tmpdir(), "ppp2-noreg2-"));
  process.env.FRONDOSE_HOME_BASE = home;
  const dbPath = pathJoin(home, ".frondose", "agent", "sales.sqlite");
  const db = getSalesDb(dbPath);
  const profileUrl = `https://www.linkedin.com/in/${slug}/`;
  const { candidateId } = upsertRawCandidate(db, {
    personName: "Test Lead",
    profileUrl,
    source: "search",
  });
  const leadId = insertLead(db, {
    candidateId,
    personName: "Test Lead",
    profileUrl,
    stage: "qualified",
    ownerMode: "manual",
  });
  insertDraft(db, { leadId, kind: "connect_note", text: draftText, createdBy: "user" });
  return home;
}

/**
 * Build a fake session + CdpClient for the feed-composer surface.
 *
 * STRICT-EQUAL HARNESS: dispatches evaluate by comparing expr against the imported
 * FEED_COMPOSER_EDITOR_JS and FEED_COMPOSER_FOCUS_JS constants directly.
 *
 * [Step-3a Finding 5] All feed-composer tests use "@e1" (snapshot() allocates "e1"
 * for the first AX node). verifyRef("e1") finds the entry, calls getPartialAXTree
 * (throws on fake handle), catch → {matches:true}, passes to the readiness gate.
 */
function makeFeedComposerSession(opts: {
  surface?: CurrentSurfaceContext["surface"];
  pageUrl?: string;
  entries?: Array<{ ref: string; role: string; name: string }>;
  editorJsQueue?: Array<string>;
  focusJsResult?: boolean;
  editorJsShouldThrowAfterN?: number;
  inputMode?: "cdp" | "hardware";
  // P-POST-PUBLISH-4: shadow-clear harness options.
  // clearJsResult: boolean returned when FEED_COMPOSER_CLEAR_JS is dispatched (default false →
  //   existing tests unaffected — CLEAR_JS isn't dispatched by them anyway since
  //   FEED_COMPOSER_CLEAR_JS_LOADED is undefined pre-Step-4).
  clearJsResult?: boolean;
  // clearJsShouldThrow: when true, throw on the CLEAR_JS dispatch (T-Clear.3).
  clearJsShouldThrow?: boolean;
  // reactSafeClearResult: boolean returned by the REACT_SAFE_CLEAR_ACTIVE_INPUT_JS dispatch
  //   (the otherJsCallLog default branch). Default false → existing tests unaffected.
  //   Set to true for T-Clear.4 to simulate native-textarea clear success (keyboard fallback skipped).
  reactSafeClearResult?: boolean;
  // P-POST-PUBLISH-4 Step-5a Fix 2: Post-button-enabled gate.
  // postEnabledResult: boolean returned when FEED_COMPOSER_POST_ENABLED_JS is dispatched.
  //   Default true → all happy-path tests pass the enabled gate without changes.
  //   Set to false to test the loud-fail path (T-PostEnabled.Disabled).
  //   Set to an array [false, true] to test retry-recovers (T-PostEnabled.RetryOk).
  postEnabledResult?: boolean | boolean[];
}): {
  session: {
    inputMode: "cdp" | "hardware";
    getOrInitClient: () => Promise<{ ok: true; client: CdpClient }>;
    getClient: () => CdpClient;
    setLastContext: (_ctx: CurrentSurfaceContext) => void;
    getLastContext: () => CurrentSurfaceContext;
    callLog: CallLogEntry[];
    editorJsCallLog: string[];
    focusJsCallLog: string[];
    otherJsCallLog: string[];
    callLogAll: string[];
    // P-POST-PUBLISH-4: per-call log for FEED_COMPOSER_CLEAR_JS dispatches.
    clearJsCallLog: string[];
    // P-POST-PUBLISH-4 Step-5a: per-call log for FEED_COMPOSER_POST_ENABLED_JS dispatches.
    postEnabledJsCallLog: string[];
  };
  callLog: CallLogEntry[];
  editorJsCallLog: string[];
  focusJsCallLog: string[];
  otherJsCallLog: string[];
  callLogAll: string[];
  // P-POST-PUBLISH-4
  clearJsCallLog: string[];
  // P-POST-PUBLISH-4 Step-5a
  postEnabledJsCallLog: string[];
  /** @deprecated Use editorJsCallLog. Legacy alias for backward compat. */
  evaluateCallLog: string[];
} {
  const callLog: CallLogEntry[] = [];
  const editorJsCallLog: string[] = [];
  const focusJsCallLog: string[] = [];
  const otherJsCallLog: string[] = [];
  const callLogAll: string[] = [];
  // P-POST-PUBLISH-4: dedicated call log for FEED_COMPOSER_CLEAR_JS dispatch.
  const clearJsCallLog: string[] = [];
  // P-POST-PUBLISH-4 Step-5a: dedicated call log for FEED_COMPOSER_POST_ENABLED_JS dispatch.
  const postEnabledJsCallLog: string[] = [];
  let postEnabledCallCount = 0;

  let editorJsCallCount = 0;

  const entries = opts.entries ?? [
    { ref: "@e1", role: "textbox", name: "Text editor for creating content" },
  ];
  const surface = opts.surface ?? "feed";
  const pageUrl = opts.pageUrl ?? "https://www.linkedin.com/feed/";
  const inputMode = opts.inputMode ?? "cdp";

  const editorJsQueue = opts.editorJsQueue ?? [];
  const focusJsResult = opts.focusJsResult ?? false;
  const editorJsShouldThrowAfterN = opts.editorJsShouldThrowAfterN;
  // P-POST-PUBLISH-4 harness defaults:
  //   clearJsResult defaults to false → legacy tests unaffected (they never dispatch CLEAR_JS).
  //   clearJsShouldThrow defaults to false → no-op unless explicitly set (T-Clear.3).
  const clearJsResult = opts.clearJsResult ?? false;
  const clearJsShouldThrow = opts.clearJsShouldThrow ?? false;
  // reactSafeClearResult: returned by the REACT_SAFE_CLEAR default branch (otherJsCallLog).
  // Default false → behavior byte-equal to HEAD for existing tests.
  const reactSafeClearResult = opts.reactSafeClearResult ?? false;
  // P-POST-PUBLISH-4 Step-5a Fix 2: postEnabledResult default true → happy-path tests pass.
  // Supply false for T-PostEnabled.Disabled; supply [false, true] for T-PostEnabled.RetryOk.
  const postEnabledResultOpt = opts.postEnabledResult ?? true;

  const fakeHandle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({
        nodes: entries.map((e, i) => ({
          nodeId: `ax${i}`,
          role: { type: "role", value: e.role },
          name: { type: "string", value: e.name },
          backendDOMNodeId: 100 + i,
        })),
      }),
      // getPartialAXTree is NOT implemented on the fake handle. verifyRef calls it,
      // it throws, verifyRef's catch → {matches:true}. Intentional: testing the new
      // readiness/focus/readback gates, NOT verifyRef itself.
    },
    Runtime: {
      evaluate: async (args: { expression: string }) => {
        const expr = args.expression;
        callLogAll.push(expr.slice(0, 200));

        // STRICT-EQUAL DISPATCH (Step-5 NIT fix — no substring matching).
        if (expr === FEED_COMPOSER_EDITOR_JS) {
          const callIdx = editorJsCallCount++;
          editorJsCallLog.push(`EDITOR_JS[${callIdx}]`);
          if (editorJsShouldThrowAfterN !== undefined && callIdx >= editorJsShouldThrowAfterN) {
            throw new Error(`Fake EDITOR_JS throw at call ${callIdx}`);
          }
          const response =
            editorJsQueue[callIdx] ?? JSON.stringify({ present: false, editorText: "" });
          return { result: { value: response } };
        }

        if (expr === FEED_COMPOSER_FOCUS_JS) {
          focusJsCallLog.push("FOCUS_JS");
          return { result: { value: focusJsResult } };
        }

        // P-POST-PUBLISH-4 Step-5a Fix 2: FEED_COMPOSER_POST_ENABLED_JS dispatch branch.
        // Default postEnabledResult:true → happy-path tests get ok:true without any changes.
        // Supports array form [false, true] for retry-recovers test.
        if (expr === FEED_COMPOSER_POST_ENABLED_JS) {
          const callIdx = postEnabledCallCount++;
          postEnabledJsCallLog.push(`POST_ENABLED_JS[${callIdx}]`);
          let val: boolean;
          if (Array.isArray(postEnabledResultOpt)) {
            val = postEnabledResultOpt[callIdx] ?? postEnabledResultOpt[postEnabledResultOpt.length - 1] ?? true;
          } else {
            val = postEnabledResultOpt;
          }
          return { result: { value: val } };
        }

        // P-POST-PUBLISH-4: FEED_COMPOSER_CLEAR_JS dispatch branch.
        // FEED_COMPOSER_CLEAR_JS_LOADED is undefined until Step 4 ships the export.
        // When undefined, (expr === undefined) is always false → this branch is never entered →
        // existing T-Ghost.*/T-ReadBack.*/T-NoRegression.*/T-Hardware.* tests are unaffected.
        // After Step 4, FEED_COMPOSER_CLEAR_JS_LOADED is the real constant string → branch fires.
        if (FEED_COMPOSER_CLEAR_JS_LOADED !== undefined && expr === FEED_COMPOSER_CLEAR_JS_LOADED) {
          clearJsCallLog.push("CLEAR_JS");
          if (clearJsShouldThrow) throw new Error("Fake CLEAR_JS throw (T-Clear.3)");
          return { result: { value: clearJsResult } };
        }

        // Anything else (REACT_SAFE_CLEAR, unknown expressions) → reactSafeClearResult.
        // REACT_SAFE_CLEAR_ACTIVE_INPUT_JS: clearActiveInput returns false for a
        // contenteditable (composer is not HTMLInputElement/HTMLTextAreaElement), so
        // returning false here matches the real production behavior and causes
        // clearActiveInput to fall through to Cmd+A+Backspace via dispatchKeyEvent.
        // Set reactSafeClearResult:true (T-Clear.4) to simulate native-textarea clear success.
        otherJsCallLog.push(expr.slice(0, 80));
        return { result: { value: reactSafeClearResult } };
      },
    },
    DOM: {
      getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (_args: unknown) => ({ nodeIds: [] }),
      scrollIntoViewIfNeeded: async (_arg: unknown) => {},
      getBoxModel: async (_args: unknown) => ({ model: { border: FAKE_BORDER } }),
    },
    Input: {
      dispatchMouseEvent: async (args: { type: string; x?: number; y?: number }) => {
        callLog.push(`mouse:${args.type}:${args.x ?? 0},${args.y ?? 0}`);
      },
      dispatchKeyEvent: async (args: { type: string; key: string; modifiers?: number }) => {
        callLog.push(`key:${args.type}:${args.key}:mod${args.modifiers ?? 0}`);
      },
      insertText: async (args: { text: string }) => {
        callLog.push(`insertText:${args.text}`);
      },
    },
  };

  const client = CdpClient.fromHandle(fakeHandle);
  const evaluateCallLog = editorJsCallLog; // Legacy alias: EDITOR_JS calls primarily.

  const session = {
    inputMode,
    getOrInitClient: () => Promise.resolve({ ok: true as const, client }),
    getClient: () => client,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () =>
      ({
        pageUrl,
        surface,
        activeLayer: "page",
        entries,
      }) as CurrentSurfaceContext,
    callLog,
    editorJsCallLog,
    focusJsCallLog,
    otherJsCallLog,
    callLogAll,
    clearJsCallLog,
    postEnabledJsCallLog,
  };

  return {
    session,
    callLog,
    editorJsCallLog,
    focusJsCallLog,
    otherJsCallLog,
    callLogAll,
    clearJsCallLog,
    postEnabledJsCallLog,
    evaluateCallLog,
  };
}

/**
 * Standard feed-composer entries for T-Ghost.* + T-ReadBack.* tests.
 * [Step-3a Finding 5] Uses "@e1" so snapshot() populates refMap["e1"].
 */
const FEED_COMPOSER_ENTRIES = [
  { ref: "@e1", role: "textbox", name: "Text editor for creating content" },
];

// ---------------------------------------------------------------------------
// T-Ghost.1 — feed composer absent → fail(not_found) + zero keystrokes
// ---------------------------------------------------------------------------

describe("T-Ghost.1: feed composer absent in live DOM → type returns fail(not_found) + dispatches no keystrokes", () => {
  it(
    "when surface=feed, composer name matches COMPOSER_INPUT_RE, and evaluate returns {present:false} → fail(type, not_found) + zero insertText/dispatchKeyEvent/clickAt",
    { timeout: 10000 },
    async () => {
      // Given: getLastContext returns {surface:"feed", entries:[{ref:"@e1", role:"textbox",
      //         name:"Text editor for creating content"}], pageUrl:"https://www.linkedin.com/feed/"}.
      //   AND: FEED_COMPOSER_EDITOR_JS evaluate returns {present:false} (Insertion A probe).
      // When:  makeTypeTool(session).execute({text:"hello", ref:"@e1"}) is called.
      // Then:  returned envelope is {ok:false, command:"type", error:{kind:"not_found", ...}}.
      //   AND: client.handle.Input.insertText called ZERO times.
      //   AND: client.handle.Input.dispatchKeyEvent called ZERO times.
      //   AND: mouse:click ZERO times (gate fires before clickAt).
      const { session, callLog, editorJsCallLog, focusJsCallLog } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [JSON.stringify({ present: false, editorText: "" })],
        focusJsResult: false,
      });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hello", ref: "@e1" },
        { toolCallId: "t-ghost1", messages: [], abortSignal },
      );

      assert.equal(result.ok, false, "T-Ghost.1: result must be ok:false");
      assert.equal(
        (result as { ok: false; command: string; error: { kind: string } }).command,
        "type",
        "T-Ghost.1: command must be 'type'",
      );
      assert.equal(
        (result as { ok: false; command: string; error: { kind: string } }).error.kind,
        "not_found",
        "T-Ghost.1: error.kind must be 'not_found'",
      );
      // not_found message must mention composer re-open or "Start a post".
      const msg = (result as { ok: false; error: { message: string } }).error.message;
      assert.match(
        msg,
        /re-open|Start a post/i,
        "T-Ghost.1: error.message must mention re-open or 'Start a post'",
      );

      const insertCount = callLog.filter((c) => c.startsWith("insertText:")).length;
      assert.equal(insertCount, 0, "T-Ghost.1: insertText must be called ZERO times");

      const keyCount = callLog.filter((c) => c.startsWith("key:")).length;
      assert.equal(keyCount, 0, "T-Ghost.1: dispatchKeyEvent must be called ZERO times");

      const clickCount = callLog.filter((c) => c.startsWith("mouse:mousePressed")).length;
      assert.equal(clickCount, 0, "T-Ghost.1: clickAt must be called ZERO times (gate before clickAt)");

      assert.equal(focusJsCallLog.length, 0, "T-Ghost.1: FOCUS_JS must not be called (gate exited before Insertion B)");
    },
  );
});

// ---------------------------------------------------------------------------
// T-Ghost.2 — feed composer present → ok, FEED_COMPOSER_FOCUS_JS evaluated once,
//             clickAt ZERO times (Finding 2 + 3)
// ---------------------------------------------------------------------------

describe("T-Ghost.2: feed composer present → type proceeds via live-DOM focus, SKIPS stale-AX-ref clickAt, dispatches per-char insertText", () => {
  it(
    "when pre-loop probe returns present:true, focusFeedComposerEditorLive JS returns true, post-loop returns editorText:'hello' → ok:true, FOCUS_JS evaluated 1×, clickAt 0×, insertText 5×",
    { timeout: 10000 },
    async () => {
      // Given: getLastContext returns feed-surface + FEED_COMPOSER_ENTRIES (ref "@e1").
      //   AND: FEED_COMPOSER_EDITOR_JS queue (strict-equal dispatch):
      //        editorJsQueue[0] → {present:true, editorText:""} (Insertion A: present).
      //        editorJsQueue[1] → {present:true, editorText:""} (clearActiveInput beforeClear probe: empty → skip clear).
      //        editorJsQueue[2] → {present:true, editorText:"hello"} (Insertion C: post-loop).
      //   AND: FEED_COMPOSER_FOCUS_JS → true (Insertion B: live focus succeeded → skip clickAt).
      //   AND: REACT_SAFE_CLEAR → routes to otherJsCallLog (returns false — contenteditable fallback).
      //   AND: postEnabledResult:true (Fix 2: Post button enabled → ok:true).
      // When:  makeTypeTool(session).execute({text:"hello", ref:"@e1"}) is called.
      // Then:  returned envelope is {ok:true, command:"type", ...}.
      //   AND: [Finding 2] mouse:click (clickAt) was called ZERO times — stale-AX-ref click SKIPPED.
      //   AND: [Finding 3] focusJsCallLog.length === 1 (FOCUS_JS evaluated exactly once).
      //   AND: editorJsCallLog.length === 3 (Insertion A + beforeClear probe + Insertion C).
      //   AND: client.handle.Input.insertText called 5 times (one per char of "hello").
      const { session, callLog, editorJsCallLog, focusJsCallLog } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [
          JSON.stringify({ present: true, editorText: "" }),      // editorJsQueue[0]: Insertion A
          JSON.stringify({ present: true, editorText: "" }),      // editorJsQueue[1]: beforeClear probe (empty → skip clear)
          JSON.stringify({ present: true, editorText: "hello" }), // editorJsQueue[2]: Insertion C
        ],
        focusJsResult: true, // Insertion B: live focus succeeded → skip clickAt
        postEnabledResult: true, // Fix 2: Post button enabled
      });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hello", ref: "@e1" },
        { toolCallId: "t-ghost2", messages: [], abortSignal },
      );

      assert.equal(result.ok, true, "T-Ghost.2: result must be ok:true");
      assert.equal(
        (result as { ok: true; command: string }).command,
        "type",
        "T-Ghost.2: command must be 'type'",
      );

      // [Finding 2] clickAt must be ZERO — stale-AX-ref click skipped on happy path.
      const clickCount = callLog.filter((c) => c.startsWith("mouse:mousePressed")).length;
      assert.equal(clickCount, 0, "T-Ghost.2: clickAt must be called ZERO times (Finding 2 — live focus succeeded)");

      // [Finding 3] FOCUS_JS evaluated exactly once.
      assert.equal(
        focusJsCallLog.length,
        1,
        "T-Ghost.2: FEED_COMPOSER_FOCUS_JS must be evaluated exactly ONCE (strict-equal, payload-keyed)",
      );

      // EDITOR_JS called exactly 3 times: Insertion A + beforeClear probe + Insertion C.
      // The beforeClear probe (Fix 1) probes isFeedComposerLiveInDOM before deciding to clear;
      // since the queue returns editorText:"" the clear is skipped entirely.
      assert.equal(
        editorJsCallLog.length,
        3,
        "T-Ghost.2: FEED_COMPOSER_EDITOR_JS must be evaluated exactly 3 times (Insertion A + beforeClear probe + Insertion C)",
      );

      // insertText called 5 times (one per char of "hello").
      const insertCount = callLog.filter((c) => c.startsWith("insertText:")).length;
      assert.equal(insertCount, 5, "T-Ghost.2: insertText must be called 5 times (one per char of 'hello')");
    },
  );
});

// ---------------------------------------------------------------------------
// T-Ghost.2-fallback — feed composer present BUT live focus fails → clickAt fires
// ---------------------------------------------------------------------------

describe("T-Ghost.2-fallback: feed composer present but focusFeedComposerEditorLive returns false → clickAt fires once, still ok", () => {
  it(
    "when pre-loop probe returns present:true but FEED_COMPOSER_FOCUS_JS returns false → clickAt called 1×, post-loop matches → ok:true",
    { timeout: 10000 },
    async () => {
      // Given: getLastContext returns feed-surface + FEED_COMPOSER_ENTRIES (ref "@e1").
      //   AND: FEED_COMPOSER_EDITOR_JS:
      //        editorJsQueue[0] → {present:true, editorText:""} (Insertion A).
      //        editorJsQueue[1] → {present:true, editorText:""} (beforeClear probe: empty → skip clear).
      //        editorJsQueue[2] → {present:true, editorText:"hello"} (Insertion C).
      //   AND: FEED_COMPOSER_FOCUS_JS → false (live focus failed → clickAt fallback).
      //   AND: postEnabledResult:true (Fix 2: Post button enabled → ok:true).
      // When:  makeTypeTool(session).execute({text:"hello", ref:"@e1"}) is called.
      // Then:  returned envelope is {ok:true, …} (fallback path still works).
      //   AND: [Finding 2 fallback] mouse:click (clickAt) was called EXACTLY ONCE.
      //   AND: client.handle.Input.insertText called 5 times.
      //   AND: focusJsCallLog.length === 1 (FOCUS_JS called once, even though it returned false).
      const { session, callLog, editorJsCallLog, focusJsCallLog } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [
          JSON.stringify({ present: true, editorText: "" }),      // editorJsQueue[0]: Insertion A
          JSON.stringify({ present: true, editorText: "" }),      // editorJsQueue[1]: beforeClear probe (empty → skip)
          JSON.stringify({ present: true, editorText: "hello" }), // editorJsQueue[2]: Insertion C
        ],
        focusJsResult: false, // Insertion B: live focus failed → clickAt fallback
        postEnabledResult: true, // Fix 2: Post button enabled
      });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hello", ref: "@e1" },
        { toolCallId: "t-ghost2-fallback", messages: [], abortSignal },
      );

      assert.equal(result.ok, true, "T-Ghost.2-fallback: result must be ok:true (fallback path works)");

      // clickAt must be exactly 1 (status-quo fallback when live focus fails).
      const clickCount = callLog.filter((c) => c.startsWith("mouse:mousePressed")).length;
      assert.equal(
        clickCount,
        1,
        "T-Ghost.2-fallback: clickAt must be called exactly ONCE (live focus failed → status-quo fallback)",
      );

      // insertText 5 times.
      const insertCount = callLog.filter((c) => c.startsWith("insertText:")).length;
      assert.equal(insertCount, 5, "T-Ghost.2-fallback: insertText must be called 5 times");

      // FOCUS_JS called once (attempted, returned false).
      assert.equal(
        focusJsCallLog.length,
        1,
        "T-Ghost.2-fallback: FEED_COMPOSER_FOCUS_JS must be called once (even though it returned false)",
      );

      // EDITOR_JS 3 calls: Insertion A + beforeClear probe (empty→skip) + Insertion C.
      assert.equal(
        editorJsCallLog.length,
        3,
        "T-Ghost.2-fallback: FEED_COMPOSER_EDITOR_JS must be evaluated 3 times (Insertion A + beforeClear probe + Insertion C)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Ghost.3a — gate bypassed for messaging-thread surface
// ---------------------------------------------------------------------------

describe("T-Ghost.3a: gate bypassed for messaging-thread surface (no FEED_COMPOSER_EDITOR_JS evaluate)", () => {
  it(
    "when surface='messaging-thread' and name='Write a message…' → existing path runs, NO FEED_COMPOSER_EDITOR_JS evaluate",
    { timeout: 10000 },
    async () => {
      // Given: getLastContext returns {surface:"messaging-thread", entries:[{ref:"@e1",
      //         role:"textbox", name:"Write a message…"}]}.
      // When:  makeTypeTool(session).execute({text:"hi", ref:"@e1"}) is called.
      // Then:  type proceeds with existing path (ok:true, insertText fires).
      //   AND: NO call to evaluate(FEED_COMPOSER_EDITOR_JS) — editorJsCallLog.length===0.
      //   AND: focusJsCallLog.length===0 (FOCUS_JS not called outside feed-composer path).
      const { session, editorJsCallLog, focusJsCallLog, callLog } = makeFeedComposerSession({
        surface: "messaging-thread",
        pageUrl: "https://www.linkedin.com/messaging/thread/abc/",
        entries: [{ ref: "@e1", role: "textbox", name: "Write a message…" }],
      });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hi", ref: "@e1" },
        { toolCallId: "t-ghost3a", messages: [], abortSignal },
      );

      assert.equal(result.ok, true, "T-Ghost.3a: messaging-thread type must succeed (ok:true)");
      assert.equal(
        editorJsCallLog.length,
        0,
        "T-Ghost.3a: FEED_COMPOSER_EDITOR_JS must NEVER be called for messaging-thread surface",
      );
      assert.equal(
        focusJsCallLog.length,
        0,
        "T-Ghost.3a: FEED_COMPOSER_FOCUS_JS must NEVER be called (no live-DOM focus outside feed-composer)",
      );

      const insertCount = callLog.filter((c) => c.startsWith("insertText:")).length;
      assert.equal(insertCount, 2, "T-Ghost.3a: insertText must be called 2 times for 'hi'");
    },
  );
});

// ---------------------------------------------------------------------------
// T-Ghost.3b — gate bypassed for feed surface with "Start a post" name
// ---------------------------------------------------------------------------

describe("T-Ghost.3b: gate bypassed for feed surface when name is 'Start a post' (button, not composer editor)", () => {
  it(
    "when surface='feed' but name='Start a post' (does not match COMPOSER_INPUT_RE) → existing path, no FEED_COMPOSER_EDITOR_JS evaluate",
    { timeout: 10000 },
    async () => {
      // Given: getLastContext returns {surface:"feed", entries:[{ref:"@e1", role:"button",
      //         name:"Start a post"}]}.
      //        "Start a post" does NOT match COMPOSER_INPUT_RE.
      // When:  makeTypeTool(session).execute({text:"x", ref:"@e1"}) is called.
      // Then:  gate does NOT fire — editorJsCallLog.length===0.
      const { session, editorJsCallLog } = makeFeedComposerSession({
        surface: "feed",
        pageUrl: "https://www.linkedin.com/feed/",
        entries: [{ ref: "@e1", role: "button", name: "Start a post" }],
      });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "x", ref: "@e1" },
        { toolCallId: "t-ghost3b", messages: [], abortSignal },
      );

      // The gate condition (surface==="feed" AND COMPOSER_INPUT_RE.test(name)) is false
      // because "Start a post" does not match COMPOSER_INPUT_RE.
      assert.equal(
        editorJsCallLog.length,
        0,
        "T-Ghost.3b: FEED_COMPOSER_EDITOR_JS must NEVER be called (name 'Start a post' does not match COMPOSER_INPUT_RE)",
      );
      // result may be ok or fail based on other conditions (no preconditions to make it ok here)
      // but the key assertion is editorJsCallLog.length===0.
      void result; // acknowledged
    },
  );
});

// ---------------------------------------------------------------------------
// T-Ghost.3c — gate bypassed for profile surface connect-note
// ---------------------------------------------------------------------------

describe("T-Ghost.3c: gate bypassed for profile surface connect-note ('Add a note to your invitation')", () => {
  it(
    "when surface='profile' and name='Add a note to your invitation' → connect-note guard fires upstream, no FEED_COMPOSER_EDITOR_JS evaluate",
    { timeout: 10000 },
    async () => {
      // Given: getLastContext returns {surface:"profile", entries include connect-modal shape,
      //         pageUrl:"https://www.linkedin.com/in/test-slug/"}.
      //        "Add a note to your invitation" does NOT match COMPOSER_INPUT_RE.
      //        connect-note guard fires UPSTREAM (before new gate).
      // When:  makeTypeTool(session).execute({text:"Hi", ref:"@e2"}) is called.
      // Then:  the FEED_COMPOSER_EDITOR_JS evaluate is NEVER called (editorJsCallLog.length===0).
      const { session, editorJsCallLog } = makeFeedComposerSession({
        surface: "profile",
        pageUrl: "https://www.linkedin.com/in/test-slug/",
        entries: [
          { ref: "@e1", role: "heading", name: "Add a note to your invitation" },
          { ref: "@e2", role: "textbox", name: "Message" },
          { ref: "@e3", role: "button", name: "Send invitation" },
        ],
      });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      // No draft seeded → connect-note guard returns invalid_input (expected).
      const result = await tool.execute(
        { text: "Hi", ref: "@e2" },
        { toolCallId: "t-ghost3c", messages: [], abortSignal },
      );

      assert.equal(
        editorJsCallLog.length,
        0,
        "T-Ghost.3c: FEED_COMPOSER_EDITOR_JS must NEVER be called (profile surface — connect-note guard fires upstream)",
      );
      // connect-note guard should have fired (no draft seeded → invalid_input).
      assert.equal(result.ok, false, "T-Ghost.3c: connect-note guard must have fired (no draft → invalid_input)");
    },
  );
});

// ---------------------------------------------------------------------------
// T-NoRegression.1 — messaging-thread typing path unchanged
// ---------------------------------------------------------------------------

describe("T-NoRegression.1: messaging-thread typing path (P-MSG-SEND regression guard)", () => {
  it(
    "when surface='messaging-thread', ok:true returned, zero FEED_COMPOSER_EDITOR_JS evaluates, FEED_COMPOSER_FOCUS_JS NEVER called, insertText 2× for 'hi', clickAt WAS called",
    { timeout: 10000 },
    async () => {
      // Given: getLastContext returns {surface:"messaging-thread", entries:[{ref:"@e1",
      //         role:"textbox", name:"Write a message…"}], pageUrl:messaging-thread URL}.
      // When:  type({text:"hi", ref:"@e1"}).execute() is called.
      // Then:  ok:true; editorJsCallLog.length===0; focusJsCallLog.length===0;
      //        insertText called 2× ("h", "i");
      //        mouse:click (clickAt) WAS called (existing focus path preserved on non-feed-composer).
      const { session, editorJsCallLog, focusJsCallLog, callLog } = makeFeedComposerSession({
        surface: "messaging-thread",
        pageUrl: "https://www.linkedin.com/messaging/thread/abc/",
        entries: [{ ref: "@e1", role: "textbox", name: "Write a message…" }],
      });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hi", ref: "@e1" },
        { toolCallId: "t-noreg1", messages: [], abortSignal },
      );

      assert.equal(result.ok, true, "T-NoRegression.1: messaging-thread type must succeed (ok:true)");

      assert.equal(
        editorJsCallLog.length,
        0,
        "T-NoRegression.1: FEED_COMPOSER_EDITOR_JS must NEVER be called (gate must not fire on messaging-thread)",
      );

      assert.equal(
        focusJsCallLog.length,
        0,
        "T-NoRegression.1: FEED_COMPOSER_FOCUS_JS must NEVER be called (no live-DOM focus shim outside feed-composer)",
      );

      const insertCount = callLog.filter((c) => c.startsWith("insertText:")).length;
      assert.equal(insertCount, 2, "T-NoRegression.1: insertText must be called 2 times for 'hi'");

      // clickAt WAS called (existing focus path on non-feed-composer preserved).
      const clickCount = callLog.filter((c) => c.startsWith("mouse:mousePressed")).length;
      assert.ok(clickCount >= 1, "T-NoRegression.1: clickAt must be called (existing focus path preserved on non-feed-composer)");
    },
  );
});

// ---------------------------------------------------------------------------
// T-NoRegression.2 — connect-note brand-safety guard still fires upstream (Finding 6)
// ---------------------------------------------------------------------------

describe("T-NoRegression.2: connect-note brand-safety guard — 'Refusing to type rewritten text' when draft exists but typed text differs", () => {
  it(
    "when inConnectModal=true + profileSlugFromUrl non-null + latestDraftTextForCurrentLead returns 'Hi Mary, …' + typed text is different → invalid_input/Refusing to type rewritten text + zero FEED_COMPOSER_EDITOR_JS evaluates",
    { timeout: 10000 },
    async () => {
      // [Finding 6] Plan T-NoRegression.2 intent: saved draft EXISTS for this lead;
      // caller types a DIFFERENT (rewritten) text → "Refusing to type rewritten text" fires,
      // UPSTREAM of the feed gate. editorJsCallLog.length===0.
      //
      // Given: surface="profile"; pageUrl="/in/noreg2-slug/"; connect-modal entries;
      //   AND: draft "Hi Mary, looking forward to connecting!" seeded for slug "noreg2-slug".
      //   AND: caller types "Hi MARY, looking forward to connecting!" (different case).
      // When:  type({text:"Hi MARY, ...", ref:"@e2"}).execute() is called.
      // Then:  ok:false, error.kind==="invalid_input", message matches /Refusing to type rewritten text/i.
      //   AND: editorJsCallLog.length===0 (FEED_COMPOSER_EDITOR_JS never called).
      const slug = "noreg2-slug";
      const savedDraft = "Hi Mary, looking forward to connecting!";
      const rewrittenText = "Hi MARY, looking forward to connecting!";
      const home = seedSalesDb(slug, savedDraft);
      try {
        const { session, editorJsCallLog } = makeFeedComposerSession({
          surface: "profile",
          pageUrl: `https://www.linkedin.com/in/${slug}/`,
          entries: [
            { ref: "@e1", role: "heading", name: "Add a note to your invitation" },
            { ref: "@e2", role: "textbox", name: "Message" },
            { ref: "@e3", role: "button", name: "Send invitation" },
          ],
        });
        await session.getClient().snapshot();
        const tool = makeTypeTool(session);
        const result = await tool.execute(
          { text: rewrittenText, ref: "@e2" },
          { toolCallId: "t-noreg2", messages: [], abortSignal },
        );

        assert.equal(result.ok, false, "T-NoRegression.2: result must be ok:false (connect-note guard fired)");
        assert.equal(
          (result as { ok: false; error: { kind: string } }).error.kind,
          "invalid_input",
          "T-NoRegression.2: error.kind must be 'invalid_input'",
        );
        const msg = (result as { ok: false; error: { message: string } }).error.message;
        assert.match(
          msg,
          /Refusing to type rewritten text/i,
          "T-NoRegression.2: error.message must match /Refusing to type rewritten text/i",
        );

        assert.equal(
          editorJsCallLog.length,
          0,
          "T-NoRegression.2: FEED_COMPOSER_EDITOR_JS must NEVER be called (connect-note guard ran first — upstream)",
        );
      } finally {
        delete process.env.FRONDOSE_HOME_BASE;
        if (existsSync(home)) cleanupTmpDir(home);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-NoRegression.3 — ref re-validation still fires upstream of the feed gate
// ---------------------------------------------------------------------------

describe("T-NoRegression.3: ref re-validation (ref_stale) fires upstream — feed gate never reached", () => {
  it(
    "when verifyRef returns {matches:false} for messaging-thread ref → runtime_error ref_stale, no FEED_COMPOSER_EDITOR_JS evaluate",
    { timeout: 10000 },
    async () => {
      // Given: surface="messaging-thread"; entries=[{ref:"@e1", role:"textbox", name:"Recipient"}].
      //         client.verifyRef patched to return {matches:false} for any ref.
      // When:  type({text:"hello", ref:"@e1"}).execute() is called.
      // Then:  result.ok===false, error.kind==="runtime_error", message matches /ref_stale/;
      //   AND: editorJsCallLog.length===0 (EDITOR_JS never called — feed gate condition false anyway).
      const { session, editorJsCallLog } = makeFeedComposerSession({
        surface: "messaging-thread",
        pageUrl: "https://www.linkedin.com/messaging/thread/abc/",
        entries: [{ ref: "@e1", role: "textbox", name: "Recipient" }],
      });
      // Patch verifyRef on the client to return {matches:false}.
      const client = session.getClient();
      (client as unknown as Record<string, unknown>)["verifyRef"] = async (
        _refKey: string,
        _expected: { role: string; name: string },
      ) => {
        return { matches: false, currentRole: "textbox", currentName: "Type a message…" };
      };
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hello", ref: "@e1" },
        { toolCallId: "t-noreg3", messages: [], abortSignal },
      );

      assert.equal(result.ok, false, "T-NoRegression.3: result must be ok:false (ref_stale)");
      assert.equal(
        (result as { ok: false; error: { kind: string } }).error.kind,
        "runtime_error",
        "T-NoRegression.3: error.kind must be 'runtime_error'",
      );
      const msg = (result as { ok: false; error: { message: string } }).error.message;
      assert.match(msg, /ref_stale/, "T-NoRegression.3: error.message must match /ref_stale/");

      assert.equal(
        editorJsCallLog.length,
        0,
        "T-NoRegression.3: FEED_COMPOSER_EDITOR_JS must NEVER be called (ref_stale fires upstream; surface also non-feed)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-ReadBack.1 — persistent mismatch: BOTH probes return empty → fail(runtime_error)
// ---------------------------------------------------------------------------

describe("T-ReadBack.1: both post-loop probes return editorText:'' (persistent mismatch) → fail(type, runtime_error)", () => {
  it(
    "when pre-loop probe present:true AND first post-loop editorText:'' AND second post-loop (after 120ms) editorText:'' → runtime_error re-inspect hint",
    { timeout: 15000 },
    async () => {
      // Given: feed-composer present path (Insertion A + B happy path with "@e1").
      //   AND: FEED_COMPOSER_EDITOR_JS queue (strict-equal dispatch):
      //        editorJsQueue[0] → {present:true, editorText:""} (Insertion A: present).
      //        editorJsQueue[1] → {present:true, editorText:""} (beforeClear probe: empty → skip clear).
      //        editorJsQueue[2] → {present:true, editorText:""} (Insertion C first: mismatch).
      //        editorJsQueue[3] → {present:true, editorText:""} (Insertion C second: still mismatch).
      //   AND: FEED_COMPOSER_FOCUS_JS → true (Insertion B: live focus — happy path).
      // When:  type({text:"hello", ref:"@e1"}).execute() is called.
      // Then:  result.ok===false, command:"type", error.kind==="runtime_error",
      //         error.message matches /composer body did not match.*re-inspect/i (persistent mismatch).
      const { session } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [
          JSON.stringify({ present: true, editorText: "" }),   // editorJsQueue[0]: Insertion A
          JSON.stringify({ present: true, editorText: "" }),   // editorJsQueue[1]: beforeClear probe (empty → skip)
          JSON.stringify({ present: true, editorText: "" }),   // editorJsQueue[2]: Insertion C first (mismatch)
          JSON.stringify({ present: true, editorText: "" }),   // editorJsQueue[3]: Insertion C second (still mismatch)
        ],
        focusJsResult: true,
      });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hello", ref: "@e1" },
        { toolCallId: "t-readback1", messages: [], abortSignal },
      );

      assert.equal(result.ok, false, "T-ReadBack.1: result must be ok:false (persistent mismatch)");
      assert.equal(
        (result as { ok: false; error: { kind: string } }).error.kind,
        "runtime_error",
        "T-ReadBack.1: error.kind must be 'runtime_error'",
      );
      const msg = (result as { ok: false; error: { message: string } }).error.message;
      assert.match(
        msg,
        /composer body did not match|re-inspect/i,
        "T-ReadBack.1: error.message must mention mismatch + re-inspect",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-ReadBack.2 — whitespace-normalized match → ok
// ---------------------------------------------------------------------------

describe("T-ReadBack.2: post-loop read-back whitespace-normalized match → ok", () => {
  it(
    "when post-loop editorText has double spaces + trailing newline that normalize to the intended text → ok:true",
    { timeout: 10000 },
    async () => {
      // Given: feed-composer present path; intended text = "Hello world".
      //   AND: FEED_COMPOSER_EDITOR_JS queue:
      //        editorJsQueue[0] → {present:true, editorText:""} (Insertion A).
      //        editorJsQueue[1] → {present:true, editorText:""} (beforeClear probe: empty → skip clear).
      //        editorJsQueue[2] → {present:true, editorText:"Hello  world\n"} (Insertion C: normalized match).
      //        composerTextMatches normalizes: collapse [ \t]+ runs → "Hello world"; strip trailing \n →
      //        "Hello world" === "Hello world" → match.
      //   AND: FEED_COMPOSER_FOCUS_JS → true (Insertion B).
      //   AND: postEnabledResult:true (Fix 2: Post button enabled → ok:true).
      // When:  type({text:"Hello world", ref:"@e1"}).execute() is called.
      // Then:  result.ok===true (whitespace-normalized match).
      const { session } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [
          JSON.stringify({ present: true, editorText: "" }),
          JSON.stringify({ present: true, editorText: "" }),          // beforeClear probe (empty → skip)
          JSON.stringify({ present: true, editorText: "Hello  world\n" }),
        ],
        focusJsResult: true,
        postEnabledResult: true, // Fix 2: Post button enabled
      });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "Hello world", ref: "@e1" },
        { toolCallId: "t-readback2", messages: [], abortSignal },
      );

      assert.equal(result.ok, true, "T-ReadBack.2: result must be ok:true (whitespace-normalized match)");
    },
  );
});

// ---------------------------------------------------------------------------
// T-ReadBack.3 — post-loop probe throws → fail-closed runtime_error
// ---------------------------------------------------------------------------

describe("T-ReadBack.3: post-loop probe throws → fail-closed runtime_error (composer body verification failed)", () => {
  it(
    "when pre-loop probe + FOCUS_JS succeed but post-loop evaluate throws → runtime_error (fail-closed, not silent ok)",
    { timeout: 10000 },
    async () => {
      // Given: feed-composer present path (pre-loop EDITOR_JS call [0] succeeds; FOCUS_JS succeeds).
      //   AND: post-loop EDITOR_JS call [1] THROWS (editorJsShouldThrowAfterN=1, 0-indexed).
      //        isFeedComposerLiveInDOM catches throw → returns {present:false} (T-Helper.3 behavior).
      //   AND: REACT_SAFE_CLEAR → routes to otherJsCallLog (does NOT increment editorJsCallCount).
      // When:  type({text:"hello", ref:"@e1"}).execute() is called.
      // Then:  result.ok===false, error.kind==="runtime_error",
      //         error.message matches /composer body verification failed|re-inspect/i.
      //
      // NOTE: editorJsShouldThrowAfterN=1 (0-indexed): throw on the 2nd EDITOR_JS call.
      //   EDITOR_JS call [0] = Insertion A (pre-loop); EDITOR_JS call [1] = Insertion C (post-loop).
      //   REACT_SAFE_CLEAR is NOT an EDITOR_JS call, does not increment editorJsCallCount.
      const { session } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [
          JSON.stringify({ present: true, editorText: "" }), // editorJsQueue[0]: Insertion A (succeeds)
          // editorJsQueue[1]: would be Insertion C (post-loop) — throw fires before queue drain
        ],
        focusJsResult: true,
        editorJsShouldThrowAfterN: 1, // throw on EDITOR_JS call index 1 (post-loop, 0-indexed)
      });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hello", ref: "@e1" },
        { toolCallId: "t-readback3", messages: [], abortSignal },
      );

      assert.equal(result.ok, false, "T-ReadBack.3: result must be ok:false (post-loop probe threw → fail-closed)");
      assert.equal(
        (result as { ok: false; error: { kind: string } }).error.kind,
        "runtime_error",
        "T-ReadBack.3: error.kind must be 'runtime_error'",
      );
      const msg = (result as { ok: false; error: { message: string } }).error.message;
      assert.match(
        msg,
        /composer body verification failed|no longer present|re-inspect/i,
        "T-ReadBack.3: error.message must match /composer body verification failed|re-inspect/i",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-ReadBack.4 — read-back NOT applied to non-feed-composer paths
// ---------------------------------------------------------------------------

describe("T-ReadBack.4: post-loop read-back NOT fired for messaging-thread (non-feed-composer) path", () => {
  it(
    "when surface='messaging-thread', per-char loop completes → zero post-loop FEED_COMPOSER_EDITOR_JS evaluate calls",
    { timeout: 10000 },
    async () => {
      // Given: getLastContext returns messaging-thread surface; text = "hi" (2 chars, non-feed).
      // When:  type({text:"hi", ref:"@e1"}).execute() completes.
      // Then:  editorJsCallLog.length===0 (NO EDITOR_JS calls at any point).
      //        Messaging typing returns ok:true without any composer probe.
      const { session, editorJsCallLog } = makeFeedComposerSession({
        surface: "messaging-thread",
        pageUrl: "https://www.linkedin.com/messaging/thread/abc/",
        entries: [{ ref: "@e1", role: "textbox", name: "Write a message…" }],
      });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hi", ref: "@e1" },
        { toolCallId: "t-readback4", messages: [], abortSignal },
      );

      assert.equal(result.ok, true, "T-ReadBack.4: messaging-thread type must succeed (ok:true)");
      assert.equal(
        editorJsCallLog.length,
        0,
        "T-ReadBack.4: FEED_COMPOSER_EDITOR_JS must be called ZERO times for messaging-thread path (no pre-loop AND no post-loop probe)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-ReadBack.5 — first post-loop mismatch, 120ms wait, second probe matches → ok
// ---------------------------------------------------------------------------

describe("T-ReadBack.5: first post-loop mismatch, bounded re-probe (120ms) matches → ok (serialization-tick tolerance)", () => {
  it(
    "when first post-loop returns editorText:'hello worl' (partial) and second probe (after 120ms) returns editorText:'hello world' → ok:true; 3 total FEED_COMPOSER_EDITOR_JS evaluates",
    { timeout: 15000 },
    async () => {
      // Given: feed-composer present path (Insertion A + B happy path) with intended "hello world".
      //   AND: FEED_COMPOSER_EDITOR_JS queue:
      //        editorJsQueue[0] → {present:true, editorText:""} (Insertion A).
      //        editorJsQueue[1] → {present:true, editorText:""} (beforeClear probe: empty → skip clear).
      //        editorJsQueue[2] → {present:true, editorText:"hello worl"} (Insertion C first: mismatch).
      //        editorJsQueue[3] → {present:true, editorText:"hello world"} (Insertion C second after 120ms: match).
      //   AND: FEED_COMPOSER_FOCUS_JS → true (Insertion B).
      //   AND: postEnabledResult:true (Fix 2: Post button enabled → ok:true).
      // When:  type({text:"hello world", ref:"@e1"}).execute() is called.
      // Then:  returned envelope is {ok:true, …}.
      //   AND: editorJsCallLog.length===4 (pre-loop[0] + beforeClear[1] + Insertion C first[2] + Insertion C second[3]).
      //   AND: focusJsCallLog.length===1 (FOCUS_JS once — Insertion B).
      const { session, editorJsCallLog, focusJsCallLog } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [
          JSON.stringify({ present: true, editorText: "" }),             // editorJsQueue[0]: Insertion A
          JSON.stringify({ present: true, editorText: "" }),             // editorJsQueue[1]: beforeClear probe (empty → skip)
          JSON.stringify({ present: true, editorText: "hello worl" }),   // editorJsQueue[2]: Insertion C first (mismatch)
          JSON.stringify({ present: true, editorText: "hello world" }),  // editorJsQueue[3]: Insertion C second (match)
        ],
        focusJsResult: true,
        postEnabledResult: true, // Fix 2: Post button enabled
      });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hello world", ref: "@e1" },
        { toolCallId: "t-readback5", messages: [], abortSignal },
      );

      assert.equal(result.ok, true, "T-ReadBack.5: result must be ok:true (bounded re-probe matched)");

      // EDITOR_JS called exactly 4 times: pre-loop[0] + beforeClear probe[1] + Insertion C first[2] + Insertion C second[3].
      // This count is over FEED_COMPOSER_EDITOR_JS payload SPECIFICALLY — robust to
      // any interleaved FOCUS_JS + REACT_SAFE_CLEAR evaluates (they route to other logs).
      assert.equal(
        editorJsCallLog.length,
        4,
        "T-ReadBack.5: FEED_COMPOSER_EDITOR_JS must be called exactly 4 times (pre-loop[0] + beforeClear[1] + Insertion C first[2] + Insertion C second-after-wait[3])",
      );

      // FOCUS_JS called exactly once (Insertion B).
      assert.equal(
        focusJsCallLog.length,
        1,
        "T-ReadBack.5: FEED_COMPOSER_FOCUS_JS must be called exactly once (Insertion B)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-ReadBack.6 — second post-loop probe still mismatches → fail(runtime_error)
// ---------------------------------------------------------------------------

describe("T-ReadBack.6: both post-loop probes mismatch → fail(type, runtime_error) (bounded re-probe doesn't mask real failure)", () => {
  it(
    "when first post-loop editorText:'' AND second post-loop (after 120ms) editorText:'' → runtime_error re-inspect",
    { timeout: 15000 },
    async () => {
      // Given: feed-composer present path with intended "hello".
      //   AND: FEED_COMPOSER_EDITOR_JS queue:
      //        editorJsQueue[0] → {present:true, editorText:""} (Insertion A).
      //        editorJsQueue[1] → {present:true, editorText:""} (beforeClear probe: empty → skip clear).
      //        editorJsQueue[2] → {present:true, editorText:""} (Insertion C first: mismatch).
      //        editorJsQueue[3] → {present:true, editorText:""} (Insertion C second after 120ms: still mismatch).
      //   AND: FEED_COMPOSER_FOCUS_JS → true (Insertion B).
      // When:  type({text:"hello", ref:"@e1"}).execute() is called.
      // Then:  result.ok===false, command:"type", error.kind==="runtime_error",
      //         error.message matches /composer body did not match|re-inspect/i.
      const { session } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [
          JSON.stringify({ present: true, editorText: "" }),   // editorJsQueue[0]: Insertion A
          JSON.stringify({ present: true, editorText: "" }),   // editorJsQueue[1]: beforeClear probe (empty → skip)
          JSON.stringify({ present: true, editorText: "" }),   // editorJsQueue[2]: Insertion C first (mismatch)
          JSON.stringify({ present: true, editorText: "" }),   // editorJsQueue[3]: Insertion C second (still mismatch)
        ],
        focusJsResult: true,
      });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hello", ref: "@e1" },
        { toolCallId: "t-readback6", messages: [], abortSignal },
      );

      assert.equal(result.ok, false, "T-ReadBack.6: result must be ok:false (both post-loop probes mismatched)");
      assert.equal(
        (result as { ok: false; error: { kind: string } }).error.kind,
        "runtime_error",
        "T-ReadBack.6: error.kind must be 'runtime_error'",
      );
      const msg = (result as { ok: false; error: { message: string } }).error.message;
      assert.match(
        msg,
        /composer body did not match|re-inspect/i,
        "T-ReadBack.6: error.message must match /composer body did not match|re-inspect/i",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-ReadBack.7 — absent-composer on first post-loop probe → fail-FAST, exactly ONE Insertion-C evaluate
// ---------------------------------------------------------------------------

describe("T-ReadBack.7: absent-composer on first post-loop probe → fail-FAST (no 120ms wait, no second probe)", () => {
  it(
    "when post-loop isFeedComposerLiveInDOM returns {present:false} → runtime_error; Insertion-C evaluate called exactly ONCE (not twice)",
    { timeout: 10000 },
    async () => {
      // Given: feed-composer was present at Insertion A (passed); per-char loop ran.
      //   AND: FEED_COMPOSER_EDITOR_JS queue:
      //        editorJsQueue[0] → {present:true, editorText:""} (Insertion A).
      //        editorJsQueue[1] → {present:true, editorText:""} (beforeClear probe: empty → skip clear).
      //        editorJsQueue[2] → {present:false, editorText:""} (Insertion C first: absent — fail-FAST).
      //        editorJsQueue[3]: intentionally absent (must NOT be called — absent-composer is fail-fast).
      //   AND: FEED_COMPOSER_FOCUS_JS → true (Insertion B).
      // When:  type({text:"hello", ref:"@e1"}).execute() is called.
      // Then:  result.ok===false, error.kind==="runtime_error",
      //         error.message matches /no longer present|composer.*closed/i.
      //   AND: editorJsCallLog.length===3 (Insertion A[0] + beforeClear probe[1] + Insertion C first[2]; NO second probe).
      //        The absent-ghost path is fail-fast — ONLY present:true mismatches trigger re-probe.
      const { session, editorJsCallLog } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [
          JSON.stringify({ present: true, editorText: "" }),   // editorJsQueue[0]: Insertion A
          JSON.stringify({ present: true, editorText: "" }),   // editorJsQueue[1]: beforeClear probe (empty → skip)
          JSON.stringify({ present: false, editorText: "" }),  // editorJsQueue[2]: Insertion C (absent — fail-FAST)
          // editorJsQueue[3]: intentionally absent (must NOT be called)
        ],
        focusJsResult: true,
      });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hello", ref: "@e1" },
        { toolCallId: "t-readback7", messages: [], abortSignal },
      );

      assert.equal(result.ok, false, "T-ReadBack.7: result must be ok:false (absent-composer fail-FAST)");
      assert.equal(
        (result as { ok: false; error: { kind: string } }).error.kind,
        "runtime_error",
        "T-ReadBack.7: error.kind must be 'runtime_error'",
      );
      const msg = (result as { ok: false; error: { message: string } }).error.message;
      assert.match(
        msg,
        /no longer present|composer.*closed/i,
        "T-ReadBack.7: error.message must match /no longer present|composer.*closed/i (absent-composer ghost path)",
      );

      // EDITOR_JS called exactly 3 times: Insertion A[0] + beforeClear probe[1] + Insertion C first[2].
      // NO second probe (fail-FAST — absent-composer does NOT trigger the 120ms re-probe).
      // Count is over FEED_COMPOSER_EDITOR_JS payload SPECIFICALLY — robust to FOCUS_JS + REACT_SAFE_CLEAR.
      assert.equal(
        editorJsCallLog.length,
        3,
        "T-ReadBack.7: FEED_COMPOSER_EDITOR_JS must be called exactly 3 times (Insertion A[0] + beforeClear probe[1] + Insertion C first[2]; no second probe — absent-composer is fail-FAST)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Hardware.1 — hardware mode + feed composer absent → fail(not_found) BEFORE hardwareTypeAt
// ---------------------------------------------------------------------------

describe("T-Hardware.1: hardware mode + feed composer absent → fail(not_found) before hardwareTypeAt", () => {
  it(
    "when inputMode='hardware' + surface=feed + composer absent in live DOM → fail(type, not_found); hardwareTypeAt not invoked",
    { timeout: 10000 },
    async () => {
      // Given: inputMode="hardware" (Finding 7 — gate must fire regardless of input mode).
      //   AND: getLastContext returns feed-surface + FEED_COMPOSER_ENTRIES (ref "@e1").
      //   AND: FEED_COMPOSER_EDITOR_JS: editorJsQueue[0] → {present:false} (Insertion A: absent).
      //        Insertion A fires BEFORE the inputMode branch (plan §4 step 6 ordering).
      // When:  makeTypeTool(session).execute({text:"hello", ref:"@e1"}) is called.
      // Then:  result.ok===false, error.kind==="not_found"
      //         (same envelope as T-Ghost.1 — readiness gate fires before the hardware/cdp branch).
      //   AND: editorJsCallLog.length===1 (exactly ONE EDITOR_JS call — Insertion A only).
      //   AND: callLog has NO insertText events (hardware path never reached).
      //
      // Indirect verification: if ok:false with not_found is returned, hardwareTypeAt
      // could not have run (Insertion A exited early at plan §4 step 4, before step 6).
      const { session, callLog, editorJsCallLog } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [JSON.stringify({ present: false, editorText: "" })],
        focusJsResult: false,
        inputMode: "hardware",
      });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hello", ref: "@e1" },
        { toolCallId: "t-hardware1", messages: [], abortSignal },
      );

      assert.equal(result.ok, false, "T-Hardware.1: result must be ok:false (readiness gate fires before hardware branch)");
      assert.equal(
        (result as { ok: false; error: { kind: string } }).error.kind,
        "not_found",
        "T-Hardware.1: error.kind must be 'not_found' (same as T-Ghost.1 — Insertion A exit path)",
      );

      assert.equal(
        editorJsCallLog.length,
        1,
        "T-Hardware.1: FEED_COMPOSER_EDITOR_JS must be called exactly ONCE (Insertion A only; hardware branch never reached)",
      );

      // No hardware keystroke events (hardwareTypeAt never invoked → no insertText or keyDown).
      const insertCount = callLog.filter((c) => c.startsWith("insertText:")).length;
      assert.equal(insertCount, 0, "T-Hardware.1: insertText must be ZERO (hardware path not reached)");
    },
  );
});

// ---------------------------------------------------------------------------
// P-POST-PUBLISH-4 — T-Clear.1–T-Clear.4 (Step 2 scaffolds; outside-in TDD)
//
// All four tests FAIL on HEAD: FEED_COMPOSER_CLEAR_JS_LOADED is undefined (Step 4 hasn't
// shipped the export yet) so the assertions below reach assert.fail("TODO …"). After Step 4
// ships the new constant + updated clearActiveInput, these tests become fillable at Step 5.
//
// Existing T-Ghost.*/T-ReadBack.*/T-NoRegression.*/T-Hardware.* tests are unaffected:
// default clearJsResult:false + undefined FEED_COMPOSER_CLEAR_JS_LOADED → branch never fires.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T-Clear.1 — feed + shadow-clear returns true → REACT_SAFE_CLEAR + keyboard backstop SKIPPED
// ---------------------------------------------------------------------------

describe("T-Clear.1: feed composer + shadow-clear returns true → REACT_SAFE_CLEAR and keyboard backstop are SKIPPED", () => {
  it(
    "when surface=feed, clearJsResult:true → clearJsCallLog.length===1, REACT_SAFE_CLEAR NOT dispatched, no Cmd+A keyboard event, insertText×5, editorJsCallLog.length===2 (no retry)",
    { timeout: 10000 },
    async () => {
      // Given: getLastContext returns {surface:"feed", entries:[{ref:"@e1", role:"textbox",
      //         name:"Text editor for creating content"}], pageUrl:"https://www.linkedin.com/feed/"}.
      //   AND: editorJsQueue[0]→{present:true, editorText:""} (Insertion A).
      //        editorJsQueue[1]→{present:true, editorText:"residual text"} (beforeClear probe: NON-EMPTY → clear runs).
      //        editorJsQueue[2]→{present:true, editorText:"hello"} (Insertion C: match).
      //   AND: focusJsResult:true (Insertion B live focus succeeds).
      //   AND: clearJsResult:true (FEED_COMPOSER_CLEAR_JS returns true — shadow clear VERIFIED empty).
      //   AND: postEnabledResult:true (Fix 2: Post button enabled → ok:true).
      // When: makeTypeTool(session).execute({text:"hello", ref:"@e1"}) is called.
      // Then: result.ok===true; clearJsCallLog.length===1; REACT_SAFE_CLEAR NOT in otherJsCallLog;
      //        no Cmd+A key event; insertText×5; editorJsCallLog.length===3 (A + beforeClear + C, no retry).
      const { session, callLog, editorJsCallLog, otherJsCallLog, clearJsCallLog } =
        makeFeedComposerSession({
          entries: FEED_COMPOSER_ENTRIES,
          editorJsQueue: [
            JSON.stringify({ present: true, editorText: "" }),             // Insertion A: present
            JSON.stringify({ present: true, editorText: "residual text" }), // beforeClear probe: NON-EMPTY → clear runs
            JSON.stringify({ present: true, editorText: "hello" }),         // Insertion C: match
          ],
          focusJsResult: true,
          clearJsResult: true, // shadow clear VERIFIED-empty → short-circuit legacy path
          postEnabledResult: true, // Fix 2: Post button enabled
        });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hello", ref: "@e1" },
        { toolCallId: "t-clear1", messages: [], abortSignal },
      );

      assert.equal(result.ok, true, "T-Clear.1: result must be ok:true (shadow clear succeeded → happy path)");

      // CLEAR_JS dispatched exactly once.
      assert.equal(
        clearJsCallLog.length,
        1,
        "T-Clear.1: FEED_COMPOSER_CLEAR_JS must be dispatched exactly ONCE (shadow-clear attempt)",
      );

      // REACT_SAFE_CLEAR must NOT have been dispatched (shadow clear returned true → short-circuit).
      assert.equal(
        otherJsCallLog.length,
        0,
        "T-Clear.1: REACT_SAFE_CLEAR_ACTIVE_INPUT_JS must NOT be dispatched (shadow clear returned true → legacy path skipped)",
      );

      // Cmd+A keyboard backstop must NOT have fired.
      const cmdACount = callLog.filter((c) => c.startsWith("key:keyDown:a:mod")).length;
      assert.equal(cmdACount, 0, "T-Clear.1: Cmd+A keyboard backstop must NOT fire (shadow clear short-circuited the legacy path)");

      // insertText called 5 times — one per char of "hello".
      const insertCount = callLog.filter((c) => c.startsWith("insertText:")).length;
      assert.equal(insertCount, 5, "T-Clear.1: insertText must be called 5 times (one per char of 'hello')");

      // EDITOR_JS called exactly 3 times: Insertion A + beforeClear probe (non-empty → clear runs) + Insertion C (no read-back retry).
      assert.equal(
        editorJsCallLog.length,
        3,
        "T-Clear.1: FEED_COMPOSER_EDITOR_JS must be called exactly 3 times (Insertion A + beforeClear probe + Insertion C, no retry)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Clear.2 — feed + shadow-clear returns false → fall through to REACT_SAFE_CLEAR + keyboard (byte-equal)
// ---------------------------------------------------------------------------

describe("T-Clear.2: feed composer + shadow-clear returns false → fall through to REACT_SAFE_CLEAR + keyboard backstop (byte-equal to HEAD)", () => {
  it(
    "when surface=feed, clearJsResult:false → clearJsCallLog.length===1, REACT_SAFE_CLEAR dispatched, Cmd+A+Backspace ran, insertText×5",
    { timeout: 10000 },
    async () => {
      // Given: same as T-Clear.1, but clearJsResult:false (shadow clear helper reports failure —
      //        e.g. editor not found in deepFind, or innerText still non-empty after clear attempts).
      //   AND: REACT_SAFE_CLEAR dispatch default branch → returns false (contenteditable, matches HEAD).
      //   AND: editorJsQueue[1] = NON-EMPTY beforeClear probe so the clear path actually runs.
      //   AND: postEnabledResult:true (Fix 2: Post button enabled → ok:true).
      // When: makeTypeTool(session).execute({text:"hello", ref:"@e1"}) is called.
      // Then: result.ok===true; clearJsCallLog.length===1 (attempted once); otherJsCallLog.length===1
      //        (REACT_SAFE_CLEAR dispatched after helper returned false);
      //        callLog filter 'key:keyDown:a:mod4' count===1 AND 'key:keyDown:Backspace:mod0' count===1;
      //        insertText count===5.
      const { session, callLog, otherJsCallLog, clearJsCallLog } =
        makeFeedComposerSession({
          entries: FEED_COMPOSER_ENTRIES,
          editorJsQueue: [
            JSON.stringify({ present: true, editorText: "" }),             // Insertion A: present
            JSON.stringify({ present: true, editorText: "residual text" }), // beforeClear probe: NON-EMPTY → clear runs
            JSON.stringify({ present: true, editorText: "hello" }),         // Insertion C: match
          ],
          focusJsResult: true,
          clearJsResult: false,         // shadow clear reports failure → fall through
          // reactSafeClearResult defaults to false → keyboard backstop runs (byte-equal to HEAD)
          postEnabledResult: true,      // Fix 2: Post button enabled
        });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hello", ref: "@e1" },
        { toolCallId: "t-clear2", messages: [], abortSignal },
      );

      assert.equal(result.ok, true, "T-Clear.2: result must be ok:true (fall-through: clear failed but type still proceeded)");

      // CLEAR_JS attempted exactly once (helper was called, returned false).
      assert.equal(
        clearJsCallLog.length,
        1,
        "T-Clear.2: FEED_COMPOSER_CLEAR_JS must be dispatched exactly ONCE (helper attempted, returned false → fall-through)",
      );

      // REACT_SAFE_CLEAR dispatched once (fall-through from shadow-clear failure).
      assert.equal(
        otherJsCallLog.length,
        1,
        "T-Clear.2: REACT_SAFE_CLEAR_ACTIVE_INPUT_JS must be dispatched exactly ONCE (fall-through after shadow-clear returned false)",
      );

      // Keyboard backstop: Cmd+A (mod4) + Backspace (mod0) — byte-equal to HEAD.
      const cmdAKeyDownCount = callLog.filter((c) => c === "key:keyDown:a:mod4").length;
      assert.equal(cmdAKeyDownCount, 1, "T-Clear.2: key:keyDown:a:mod4 (Cmd+A select-all) must fire exactly ONCE (keyboard backstop — byte-equal to HEAD)");

      const backspaceKeyDownCount = callLog.filter((c) => c === "key:keyDown:Backspace:mod0").length;
      assert.equal(backspaceKeyDownCount, 1, "T-Clear.2: key:keyDown:Backspace:mod0 must fire exactly ONCE (keyboard backstop — byte-equal to HEAD)");

      // insertText called 5 times.
      const insertCount = callLog.filter((c) => c.startsWith("insertText:")).length;
      assert.equal(insertCount, 5, "T-Clear.2: insertText must be called 5 times (one per char of 'hello')");
    },
  );
});

// ---------------------------------------------------------------------------
// T-Clear.3 — feed + shadow-clear THROWS → swallowed, fall through (best-effort, type does NOT throw)
// ---------------------------------------------------------------------------

describe("T-Clear.3: feed composer + shadow-clear THROWS → helper swallows, falls through like T-Clear.2, type does NOT throw", () => {
  it(
    "when surface=feed, clearJsShouldThrow:true → result.ok===true, fall-through behavior matches T-Clear.2 (REACT_SAFE_CLEAR + keyboard backstop ran)",
    { timeout: 10000 },
    async () => {
      // Given: same as T-Clear.1, but clearJsShouldThrow:true (simulates CDP Inspector eval exception).
      //        editorJsQueue[1] = NON-EMPTY beforeClear probe so the clear path actually runs.
      //        postEnabledResult:true (Fix 2: Post button enabled → ok:true).
      // When: makeTypeTool(session).execute({text:"hello", ref:"@e1"}) is called.
      // Then: result.ok===true (the helper's try/catch in clearFeedComposerEditorLive swallows the throw
      //        and returns false, then clearActiveInput falls through to the legacy path — byte-equal to HEAD).
      //        REACT_SAFE_CLEAR dispatched exactly once; keyboard backstop fires; insertText×5.
      //        type does NOT re-throw (no unhandled rejection propagates out of execute()).
      const { session, callLog, otherJsCallLog, clearJsCallLog } =
        makeFeedComposerSession({
          entries: FEED_COMPOSER_ENTRIES,
          editorJsQueue: [
            JSON.stringify({ present: true, editorText: "" }),             // Insertion A: present
            JSON.stringify({ present: true, editorText: "residual text" }), // beforeClear probe: NON-EMPTY → clear runs
            JSON.stringify({ present: true, editorText: "hello" }),         // Insertion C: match
          ],
          focusJsResult: true,
          clearJsShouldThrow: true, // helper's evaluate throws → swallowed by clearFeedComposerEditorLive try/catch
          // reactSafeClearResult defaults to false → keyboard backstop runs
          postEnabledResult: true,  // Fix 2: Post button enabled
        });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);

      // type must NOT throw (fail-closed — the unhandled-rejection guard is implicit via await).
      const result = await tool.execute(
        { text: "hello", ref: "@e1" },
        { toolCallId: "t-clear3", messages: [], abortSignal },
      );

      assert.equal(result.ok, true, "T-Clear.3: result must be ok:true (helper swallowed throw, fell through to legacy path)");

      // CLEAR_JS dispatch occurred (the throw happens INSIDE the helper's evaluate call).
      // clearJsCallLog records the attempt; the throw fires AFTER the push in the harness.
      assert.equal(
        clearJsCallLog.length,
        1,
        "T-Clear.3: FEED_COMPOSER_CLEAR_JS dispatch must record 1 attempt (throw occurs during the call, caught by helper)",
      );

      // REACT_SAFE_CLEAR dispatched once (fall-through: helper returned false due to throw).
      assert.equal(
        otherJsCallLog.length,
        1,
        "T-Clear.3: REACT_SAFE_CLEAR_ACTIVE_INPUT_JS must be dispatched exactly ONCE (fall-through after throw-swallow)",
      );

      // Keyboard backstop fires (byte-equal to T-Clear.2).
      const cmdAKeyDownCount = callLog.filter((c) => c === "key:keyDown:a:mod4").length;
      assert.equal(cmdAKeyDownCount, 1, "T-Clear.3: key:keyDown:a:mod4 (Cmd+A) must fire exactly ONCE (keyboard backstop)");

      const backspaceKeyDownCount = callLog.filter((c) => c === "key:keyDown:Backspace:mod0").length;
      assert.equal(backspaceKeyDownCount, 1, "T-Clear.3: key:keyDown:Backspace:mod0 must fire exactly ONCE (keyboard backstop)");

      // insertText called 5 times.
      const insertCount = callLog.filter((c) => c.startsWith("insertText:")).length;
      assert.equal(insertCount, 5, "T-Clear.3: insertText must be called 5 times (one per char of 'hello')");
    },
  );
});

// ---------------------------------------------------------------------------
// T-Clear.4 — NON-feed (profile / connect-note) → CLEAR_JS NOT dispatched; REACT_SAFE_CLEAR ran; no keyboard fallback
// ---------------------------------------------------------------------------

describe("T-Clear.4: non-feed surface (profile, 'Add a note') → CLEAR_JS NOT dispatched; REACT_SAFE_CLEAR ran; keyboard fallback skipped (byte-equal to HEAD)", () => {
  it(
    "when surface='profile', isFeedComposer===false → clearJsCallLog.length===0, REACT_SAFE_CLEAR ran (otherJsCallLog.length===1), no Cmd+A key event",
    { timeout: 10000 },
    async () => {
      // Given: getLastContext returns {surface:"profile", entries:[{ref:"@e1", role:"textbox",
      //         name:"Add a note"}], pageUrl:"https://www.linkedin.com/in/test-lead/"}.
      //         isFeedComposer===false (surface!=="feed" AND "Add a note" doesn't match COMPOSER_INPUT_RE).
      //   AND: sales DB seeded with a connect_note draft matching the typed text (so fidelity guard passes).
      //   AND: REACT_SAFE_CLEAR returns true (native-textarea path — matches HEAD behavior for connect-note).
      // When: makeTypeTool(session).execute({text:<draftText>, ref:"@e1"}) is called.
      // Then: result.ok===true; clearJsCallLog.length===0 (CLEAR_JS NOT dispatched — new path is feed-only);
      //        otherJsCallLog.length===1 (REACT_SAFE_CLEAR ran);
      //        no Cmd+A key event (REACT_SAFE_CLEAR succeeded → keyboard fallback skipped, byte-equal to HEAD).
      //        This is the no-regression pin for the connect-note + native-input clear path.

      // The connect-note surface requires entries that satisfy inConnectModal():
      //   (TEXTBOX with NOTE_FIELD_RE name OR ADD_NOTE_RE name) AND (CLICKABLE with SEND_BTN_RE name).
      // "Add a note" matches ADD_NOTE_RE; "Send invitation" matches SEND_BTN_RE.
      const slug = "t-clear4-lead";
      const draftText = "Hi there, excited to connect!";
      const home = seedSalesDb(slug, draftText);
      try {
        const { session, callLog, otherJsCallLog, clearJsCallLog } =
          makeFeedComposerSession({
            surface: "profile",
            pageUrl: `https://www.linkedin.com/in/${slug}/`,
            entries: [
              { ref: "@e1", role: "button",  name: "Add a note" },         // ADD_NOTE_RE match
              { ref: "@e2", role: "textbox", name: "Message" },             // NOTE_FIELD_RE match (inConnectModal)
              { ref: "@e3", role: "button",  name: "Send invitation" },     // SEND_BTN_RE match
            ],
            reactSafeClearResult: true, // native-textarea clear succeeds → keyboard fallback SKIPPED
          });
        await session.getClient().snapshot();
        const tool = makeTypeTool(session);
        const result = await tool.execute(
          { text: draftText, ref: "@e2" },
          { toolCallId: "t-clear4", messages: [], abortSignal },
        );

        assert.equal(result.ok, true, "T-Clear.4: result must be ok:true (non-feed path with REACT_SAFE_CLEAR success)");

        // CLEAR_JS must NOT have been dispatched — the shadow-clear branch is gated on isFeedComposer===true.
        assert.equal(
          clearJsCallLog.length,
          0,
          "T-Clear.4: FEED_COMPOSER_CLEAR_JS must NOT be dispatched (isFeedComposer===false — profile surface + 'Add a note' name)",
        );

        // REACT_SAFE_CLEAR dispatched exactly once (the legacy clear path — unchanged from HEAD).
        assert.equal(
          otherJsCallLog.length,
          1,
          "T-Clear.4: REACT_SAFE_CLEAR_ACTIVE_INPUT_JS must be dispatched exactly ONCE (legacy path runs; isFeedComposer===false skips shadow-clear branch)",
        );

        // Keyboard fallback must NOT fire — REACT_SAFE_CLEAR returned true.
        const cmdAKeyDownCount = callLog.filter((c) => c.startsWith("key:keyDown:a:mod")).length;
        assert.equal(
          cmdAKeyDownCount,
          0,
          "T-Clear.4: Cmd+A keyboard fallback must NOT fire (REACT_SAFE_CLEAR returned true → keyboard backstop skipped, byte-equal to HEAD)",
        );
      } finally {
        delete process.env.FRONDOSE_HOME_BASE;
        if (existsSync(home)) cleanupTmpDir(home);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Clear.5 — messaging-thread composer → CLEAR_JS NEVER dispatched (green-stays-green regression pin)
//
// CONCERN-MR 1 (Step-3a critic): the existing messaging-thread tests asserted "no EDITOR_JS /
// FOCUS_JS calls + ok:true" but did NOT explicitly assert clearJsCallLog.length===0. A broad-
// surface implementation that mistakenly dispatched FEED_COMPOSER_CLEAR_JS on the messaging
// composer (and then fell through) could have slipped past those tests. This pin closes the gap.
//
// GREEN-STAYS-GREEN: this test PASSES on HEAD (FEED_COMPOSER_CLEAR_JS_LOADED is undefined →
// CLEAR_JS dispatch branch is never entered regardless of surface) AND after Step 4 (messaging-
// thread gives isFeedComposer===false → clearActiveInput is called with false → shadow-clear
// branch is skipped entirely). It is a permanent regression guard, not a fail-on-HEAD test.
// ---------------------------------------------------------------------------

describe("T-Clear.5: messaging-thread composer → FEED_COMPOSER_CLEAR_JS NEVER dispatched (shadow clear is feed-only)", () => {
  it(
    "when surface='messaging-thread', name='Write a message…' (isFeedComposer===false) → clearJsCallLog.length===0; existing REACT_SAFE_CLEAR path runs; ok:true; insertText 2×",
    { timeout: 10000 },
    async () => {
      // Given: getLastContext returns {surface:"messaging-thread",
      //         entries:[{ref:"@e1", role:"textbox", name:"Write a message…"}],
      //         pageUrl:"https://www.linkedin.com/messaging/thread/abc/"}.
      //         isFeedComposer===false (surface!=="feed" AND "Write a message…" does not
      //         match COMPOSER_INPUT_RE — /creating content|what do you want to talk about/i).
      // When:  makeTypeTool(session).execute({text:"hi", ref:"@e1"}) is called.
      // Then:  clearJsCallLog.length===0 — FEED_COMPOSER_CLEAR_JS was NEVER dispatched.
      //        The shadow-clear branch in clearActiveInput is gated on isFeedComposer===true;
      //        messaging-thread always reaches clearActiveInput(client, false) → CLEAR_JS skipped.
      //   AND: ok:true (messaging-thread typing proceeds normally).
      //   AND: editorJsCallLog.length===0 (EDITOR_JS never called — no feed-composer gate on messaging).
      //   AND: focusJsCallLog.length===0 (FOCUS_JS never called — live-DOM focus shim is feed-only).
      //   AND: insertText called 2 times (one per char of "hi").
      const { session, callLog, editorJsCallLog, focusJsCallLog, clearJsCallLog } =
        makeFeedComposerSession({
          surface: "messaging-thread",
          pageUrl: "https://www.linkedin.com/messaging/thread/abc/",
          entries: [{ ref: "@e1", role: "textbox", name: "Write a message…" }],
        });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hi", ref: "@e1" },
        { toolCallId: "t-clear5", messages: [], abortSignal },
      );

      // Primary CONCERN-MR assertion: shadow clear NEVER dispatched on messaging-thread.
      assert.equal(
        clearJsCallLog.length,
        0,
        "T-Clear.5: FEED_COMPOSER_CLEAR_JS must NEVER be dispatched for messaging-thread " +
        "(isFeedComposer===false → shadow-clear branch skipped in clearActiveInput)",
      );

      assert.equal(result.ok, true, "T-Clear.5: messaging-thread type must succeed (ok:true)");

      assert.equal(
        editorJsCallLog.length,
        0,
        "T-Clear.5: FEED_COMPOSER_EDITOR_JS must NEVER be called (no feed-composer gate on messaging-thread)",
      );

      assert.equal(
        focusJsCallLog.length,
        0,
        "T-Clear.5: FEED_COMPOSER_FOCUS_JS must NEVER be called (live-DOM focus shim is feed-only)",
      );

      const insertCount = callLog.filter((c) => c.startsWith("insertText:")).length;
      assert.equal(insertCount, 2, "T-Clear.5: insertText must be called 2 times for 'hi'");
    },
  );
});

// ---------------------------------------------------------------------------
// P-POST-PUBLISH-4 Step-5a NEW TESTS
//
// These tests cover the two new behaviors introduced by Codex's Step-5a fix:
//   Fix 1: clearActiveInput gates on editorText non-empty (empty → skip clear entirely).
//   Fix 2: isFeedComposerPostButtonEnabled check after successful read-back.
//
// These are the regression guards for the live-failure root cause:
//   clearActiveInput ran UNCONDITIONALLY on a fresh empty composer → desynced Lexical →
//   insertText landed in DOM but Post button stayed disabled → no publish.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T-PostPub5a.EmptyGate — LIVE-FAILURE REGRESSION GUARD
//
// When the feed composer is fresh/empty, clearActiveInput must skip the clear entirely.
// This is the test that would have caught the live publish failure before Step-5a.
// ---------------------------------------------------------------------------

describe("T-PostPub5a.EmptyGate: fresh/empty feed composer → clearActiveInput skips clear entirely (Fix 1 empty-gate)", () => {
  it(
    "when beforeClear probe returns editorText:'' → CLEAR_JS NOT dispatched, REACT_SAFE_CLEAR NOT dispatched, no keyboard event, insertText×5, ok:true",
    { timeout: 10000 },
    async () => {
      // Given: getLastContext returns {surface:"feed", entries:[{ref:"@e1", role:"textbox",
      //         name:"Text editor for creating content"}]}.
      //   AND: editorJsQueue[0] → {present:true, editorText:""} (Insertion A: composer found).
      //        editorJsQueue[1] → {present:true, editorText:""} (beforeClear probe: EMPTY → skip clear).
      //        editorJsQueue[2] → {present:true, editorText:"hello"} (Insertion C: match).
      //   AND: focusJsResult:true (Insertion B: live focus).
      //   AND: postEnabledResult:true (Fix 2: Post button enabled).
      // When: makeTypeTool(session).execute({text:"hello", ref:"@e1"}) is called.
      // Then: result.ok===true.
      //   AND: clearJsCallLog.length===0 — CLEAR_JS was NOT dispatched (empty editor → gate fired).
      //   AND: otherJsCallLog.length===0 — REACT_SAFE_CLEAR was NOT dispatched (clear was skipped entirely).
      //   AND: no key:keyDown:a: events (keyboard backstop not reached).
      //   AND: insertText called 5 times (per-char loop ran normally).
      //   AND: editorJsCallLog.length===3 (Insertion A + beforeClear probe (empty) + Insertion C).
      //
      // This is the regression guard for the live-failure root cause: running shadow clear on a
      // fresh empty composer desyncs Lexical → insertText DOM-only → Post button stays disabled.
      const { session, callLog, editorJsCallLog, otherJsCallLog, clearJsCallLog } =
        makeFeedComposerSession({
          entries: FEED_COMPOSER_ENTRIES,
          editorJsQueue: [
            JSON.stringify({ present: true, editorText: "" }),      // Insertion A
            JSON.stringify({ present: true, editorText: "" }),      // beforeClear probe: EMPTY → skip
            JSON.stringify({ present: true, editorText: "hello" }), // Insertion C: match
          ],
          focusJsResult: true,
          // clearJsResult not set: CLEAR_JS must NOT be dispatched at all
          postEnabledResult: true, // Fix 2: Post button enabled
        });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hello", ref: "@e1" },
        { toolCallId: "t-emptygatefix", messages: [], abortSignal },
      );

      assert.equal(result.ok, true, "T-PostPub5a.EmptyGate: result must be ok:true (empty composer → clear skipped → Lexical untouched → insertText lands)");

      // PRIMARY REGRESSION GUARD: CLEAR_JS must NOT have been dispatched.
      assert.equal(
        clearJsCallLog.length,
        0,
        "T-PostPub5a.EmptyGate: FEED_COMPOSER_CLEAR_JS must NOT be dispatched when beforeClear probe returns empty (empty-gate short-circuits the clear path)",
      );

      // REACT_SAFE_CLEAR must also NOT have been dispatched (clear was skipped entirely before the fallthrough).
      assert.equal(
        otherJsCallLog.length,
        0,
        "T-PostPub5a.EmptyGate: REACT_SAFE_CLEAR_ACTIVE_INPUT_JS must NOT be dispatched (clear path skipped entirely for empty composer)",
      );

      // Keyboard backstop must NOT have fired.
      const cmdACount = callLog.filter((c) => c.startsWith("key:keyDown:a:mod")).length;
      assert.equal(cmdACount, 0, "T-PostPub5a.EmptyGate: keyboard backstop must NOT fire (clear was skipped entirely)");

      // insertText called 5 times — per-char loop ran normally.
      const insertCount = callLog.filter((c) => c.startsWith("insertText:")).length;
      assert.equal(insertCount, 5, "T-PostPub5a.EmptyGate: insertText must be called 5 times (per-char loop ran normally)");

      // EDITOR_JS: Insertion A + beforeClear probe (empty) + Insertion C = 3 calls.
      assert.equal(
        editorJsCallLog.length,
        3,
        "T-PostPub5a.EmptyGate: FEED_COMPOSER_EDITOR_JS must be called exactly 3 times (Insertion A + beforeClear probe + Insertion C)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-PostPub5a.PostDisabled — Post-button loud-fail (Fix 2)
//
// When text lands in DOM (read-back matches) but Post button stays disabled on both
// probes → fail("type", "runtime_error", "Lexical desync") instead of silent ok:true.
// ---------------------------------------------------------------------------

describe("T-PostPub5a.PostDisabled: read-back matches but Post button disabled on both probes → runtime_error (Lexical desync signature)", () => {
  it(
    "when composerTextMatches succeeds but POST_ENABLED_JS returns false on both initial probe and retry → fail(type, runtime_error) with Lexical-desync message; POST_ENABLED_JS dispatched exactly TWICE",
    { timeout: 15000 },
    async () => {
      // Given: feed-composer present path; intended "hello".
      //   AND: editorJsQueue[0] → {present:true, editorText:""} (Insertion A).
      //        editorJsQueue[1] → {present:true, editorText:""} (beforeClear probe: empty → skip).
      //        editorJsQueue[2] → {present:true, editorText:"hello"} (Insertion C: match).
      //   AND: focusJsResult:true (Insertion B).
      //   AND: postEnabledResult:[false, false] — POST_ENABLED_JS returns false on BOTH initial probe AND retry.
      // When: makeTypeTool(session).execute({text:"hello", ref:"@e1"}) is called.
      // Then: result.ok===false, error.kind==="runtime_error".
      //   AND: error.message matches /Post button did not enable|Lexical desync/i.
      //   AND: postEnabledJsCallLog.length===2 (initial probe + one retry after READBACK_RETRY_MS).
      const { session, postEnabledJsCallLog } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [
          JSON.stringify({ present: true, editorText: "" }),      // Insertion A
          JSON.stringify({ present: true, editorText: "" }),      // beforeClear probe (empty → skip)
          JSON.stringify({ present: true, editorText: "hello" }), // Insertion C: match
        ],
        focusJsResult: true,
        postEnabledResult: [false, false], // both probes return false → loud-fail
      });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hello", ref: "@e1" },
        { toolCallId: "t-postdisabled", messages: [], abortSignal },
      );

      assert.equal(result.ok, false, "T-PostPub5a.PostDisabled: result must be ok:false (Post button disabled on both probes)");
      assert.equal(
        (result as { ok: false; error: { kind: string } }).error.kind,
        "runtime_error",
        "T-PostPub5a.PostDisabled: error.kind must be 'runtime_error'",
      );
      const msg = (result as { ok: false; error: { message: string } }).error.message;
      assert.match(
        msg,
        /Post button did not enable|Lexical/i,
        "T-PostPub5a.PostDisabled: error.message must mention Post button not enabled or Lexical desync",
      );

      // POST_ENABLED_JS dispatched exactly TWICE: initial probe + one retry.
      assert.equal(
        postEnabledJsCallLog.length,
        2,
        "T-PostPub5a.PostDisabled: FEED_COMPOSER_POST_ENABLED_JS must be dispatched exactly TWICE (initial probe + one retry after READBACK_RETRY_MS)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-PostPub5a.PostRetryOk — Post-button retry-recovers (Fix 2)
//
// Initial probe false → retry after READBACK_RETRY_MS → second probe true → ok:true.
// ---------------------------------------------------------------------------

describe("T-PostPub5a.PostRetryOk: Post button initially disabled but enabled on retry → ok:true (serialization-tick tolerance for Post button)", () => {
  it(
    "when POST_ENABLED_JS returns false on initial probe but true on retry → ok:true; POST_ENABLED_JS dispatched exactly TWICE",
    { timeout: 15000 },
    async () => {
      // Given: feed-composer present path; intended "hello".
      //   AND: editorJsQueue[0] → {present:true, editorText:""} (Insertion A).
      //        editorJsQueue[1] → {present:true, editorText:""} (beforeClear probe: empty → skip).
      //        editorJsQueue[2] → {present:true, editorText:"hello"} (Insertion C: match).
      //   AND: focusJsResult:true (Insertion B).
      //   AND: postEnabledResult:[false, true] — initial probe false, retry true (within READBACK_RETRY_MS).
      // When: makeTypeTool(session).execute({text:"hello", ref:"@e1"}) is called.
      // Then: result.ok===true (retry succeeded).
      //   AND: postEnabledJsCallLog.length===2 (initial probe returned false → retry fired → succeeded).
      const { session, postEnabledJsCallLog } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [
          JSON.stringify({ present: true, editorText: "" }),      // Insertion A
          JSON.stringify({ present: true, editorText: "" }),      // beforeClear probe (empty → skip)
          JSON.stringify({ present: true, editorText: "hello" }), // Insertion C: match
        ],
        focusJsResult: true,
        postEnabledResult: [false, true], // initial false → retry → true
      });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hello", ref: "@e1" },
        { toolCallId: "t-postretryok", messages: [], abortSignal },
      );

      assert.equal(result.ok, true, "T-PostPub5a.PostRetryOk: result must be ok:true (Post button enabled on retry)");

      // POST_ENABLED_JS dispatched exactly twice: initial (false) + retry (true).
      assert.equal(
        postEnabledJsCallLog.length,
        2,
        "T-PostPub5a.PostRetryOk: FEED_COMPOSER_POST_ENABLED_JS must be dispatched exactly TWICE (initial false → retry → true)",
      );
    },
  );
});
