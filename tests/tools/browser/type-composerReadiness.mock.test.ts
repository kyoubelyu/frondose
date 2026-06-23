/**
 * P-POST-PUBLISH-2 — T-Ghost.* + T-NoRegression.* + T-ReadBack.* + T-Hardware.* tests.
 * Step 5 — assertions filled (outside-in TDD completion).
 *
 * STRICT-EQUAL HARNESS (Step-5 NIT fix — eliminates el.focus() substring fragility):
 *
 * The fake client.evaluate now dispatches by STRICT-EQUAL comparison against the imported
 * constants FEED_COMPOSER_EDITOR_JS and FEED_COMPOSER_FOCUS_JS (from composerReadiness.js).
 * REACT_SAFE_CLEAR_ACTIVE_INPUT_JS is file-private in type.ts and cannot be imported —
 * its calls (clearActiveInput) are caught by the fallback "anything else → return false"
 * branch, which matches the real behavior (clearActiveInput returns false on contenteditable
 * and falls through to Cmd+A+Backspace via Input.dispatchKeyEvent, not another evaluate).
 *
 * Per-payload call logs (editorJsCallLog, focusJsCallLog) are keyed on strict-equal match.
 * A clearJsCallLog is no longer needed because REACT_SAFE_CLEAR now routes to the default
 * branch; we track it via "other" calls for debugging only.
 *
 * PAYLOAD-BASED CALL ORDER (feed-composer happy-path, audited 2026-06-23):
 *   [EDITOR_JS call 0] Insertion A — pre-loop readiness probe
 *   [FOCUS_JS call 0]  Insertion B — live-DOM focus
 *   [OTHER call]       clearActiveInput (REACT_SAFE_CLEAR) — returns false, fallback dispatchKeyEvent
 *   [EDITOR_JS call 1] Insertion C — post-loop read-back, first probe
 *   [EDITOR_JS call 2] Insertion C — post-loop read-back, second probe (only on present:true mismatch)
 *
 * Per-payload tracking is robust to any interleaved clearActiveInput or visual-block calls
 * that do NOT use FEED_COMPOSER_EDITOR_JS / FEED_COMPOSER_FOCUS_JS payloads.
 *
 * Runner: node --import tsx --test --experimental-test-module-mocks --test-force-exit
 *         tests/tools/browser/type-composerReadiness.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { describe, it } from "node:test";
import { CdpClient } from "../../../src/cdp/client.js";
import {
  FEED_COMPOSER_EDITOR_JS,
  FEED_COMPOSER_FOCUS_JS,
} from "../../../src/linkedin/composerReadiness.js";
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
  };
  callLog: CallLogEntry[];
  editorJsCallLog: string[];
  focusJsCallLog: string[];
  otherJsCallLog: string[];
  callLogAll: string[];
  /** @deprecated Use editorJsCallLog. Legacy alias for backward compat. */
  evaluateCallLog: string[];
} {
  const callLog: CallLogEntry[] = [];
  const editorJsCallLog: string[] = [];
  const focusJsCallLog: string[] = [];
  const otherJsCallLog: string[] = [];
  const callLogAll: string[] = [];

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

        // Anything else (REACT_SAFE_CLEAR, unknown expressions) → false.
        // REACT_SAFE_CLEAR_ACTIVE_INPUT_JS: clearActiveInput returns false for a
        // contenteditable (composer is not HTMLInputElement/HTMLTextAreaElement), so
        // returning false here matches the real production behavior and causes
        // clearActiveInput to fall through to Cmd+A+Backspace via dispatchKeyEvent.
        otherJsCallLog.push(expr.slice(0, 80));
        return { result: { value: false } };
      },
    },
    DOM: {
      getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (_args: unknown) => ({ nodeIds: [] }),
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
  };

  return {
    session,
    callLog,
    editorJsCallLog,
    focusJsCallLog,
    otherJsCallLog,
    callLogAll,
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
      //        editorJsQueue[1] → {present:true, editorText:"hello"} (Insertion C: post-loop).
      //   AND: FEED_COMPOSER_FOCUS_JS → true (Insertion B: live focus succeeded → skip clickAt).
      //   AND: REACT_SAFE_CLEAR → routes to otherJsCallLog (returns false — contenteditable fallback).
      // When:  makeTypeTool(session).execute({text:"hello", ref:"@e1"}) is called.
      // Then:  returned envelope is {ok:true, command:"type", ...}.
      //   AND: [Finding 2] mouse:click (clickAt) was called ZERO times — stale-AX-ref click SKIPPED.
      //   AND: [Finding 3] focusJsCallLog.length === 1 (FOCUS_JS evaluated exactly once).
      //   AND: editorJsCallLog.length === 2 (Insertion A + Insertion C).
      //   AND: client.handle.Input.insertText called 5 times (one per char of "hello").
      const { session, callLog, editorJsCallLog, focusJsCallLog } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [
          JSON.stringify({ present: true, editorText: "" }),      // editorJsQueue[0]: Insertion A
          JSON.stringify({ present: true, editorText: "hello" }), // editorJsQueue[1]: Insertion C
        ],
        focusJsResult: true, // Insertion B: live focus succeeded → skip clickAt
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

      // EDITOR_JS called exactly 2 times: Insertion A + Insertion C.
      assert.equal(
        editorJsCallLog.length,
        2,
        "T-Ghost.2: FEED_COMPOSER_EDITOR_JS must be evaluated exactly TWICE (Insertion A + Insertion C)",
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
      //        editorJsQueue[1] → {present:true, editorText:"hello"} (Insertion C).
      //   AND: FEED_COMPOSER_FOCUS_JS → false (live focus failed → clickAt fallback).
      // When:  makeTypeTool(session).execute({text:"hello", ref:"@e1"}) is called.
      // Then:  returned envelope is {ok:true, …} (fallback path still works).
      //   AND: [Finding 2 fallback] mouse:click (clickAt) was called EXACTLY ONCE.
      //   AND: client.handle.Input.insertText called 5 times.
      //   AND: focusJsCallLog.length === 1 (FOCUS_JS called once, even though it returned false).
      const { session, callLog, editorJsCallLog, focusJsCallLog } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [
          JSON.stringify({ present: true, editorText: "" }),      // editorJsQueue[0]: Insertion A
          JSON.stringify({ present: true, editorText: "hello" }), // editorJsQueue[1]: Insertion C
        ],
        focusJsResult: false, // Insertion B: live focus failed → clickAt fallback
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

      // EDITOR_JS 2 calls: Insertion A + Insertion C.
      assert.equal(
        editorJsCallLog.length,
        2,
        "T-Ghost.2-fallback: FEED_COMPOSER_EDITOR_JS must be evaluated twice (Insertion A + Insertion C)",
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
      //        editorJsQueue[1] → {present:true, editorText:""} (Insertion C first: mismatch).
      //        editorJsQueue[2] → {present:true, editorText:""} (Insertion C second: still mismatch).
      //   AND: FEED_COMPOSER_FOCUS_JS → true (Insertion B: live focus — happy path).
      // When:  type({text:"hello", ref:"@e1"}).execute() is called.
      // Then:  result.ok===false, command:"type", error.kind==="runtime_error",
      //         error.message matches /composer body did not match.*re-inspect/i (persistent mismatch).
      const { session } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [
          JSON.stringify({ present: true, editorText: "" }),   // editorJsQueue[0]: Insertion A
          JSON.stringify({ present: true, editorText: "" }),   // editorJsQueue[1]: Insertion C first (mismatch)
          JSON.stringify({ present: true, editorText: "" }),   // editorJsQueue[2]: Insertion C second (still mismatch)
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
      //        editorJsQueue[1] → {present:true, editorText:"Hello  world\n"} (Insertion C: normalized match).
      //        composerTextMatches normalizes: collapse [ \t]+ runs → "Hello world"; strip trailing \n →
      //        "Hello world" === "Hello world" → match.
      //   AND: FEED_COMPOSER_FOCUS_JS → true (Insertion B).
      // When:  type({text:"Hello world", ref:"@e1"}).execute() is called.
      // Then:  result.ok===true (whitespace-normalized match).
      const { session } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [
          JSON.stringify({ present: true, editorText: "" }),
          JSON.stringify({ present: true, editorText: "Hello  world\n" }),
        ],
        focusJsResult: true,
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
      //        editorJsQueue[1] → {present:true, editorText:"hello worl"} (Insertion C first: mismatch).
      //        editorJsQueue[2] → {present:true, editorText:"hello world"} (Insertion C second after 120ms: match).
      //   AND: FEED_COMPOSER_FOCUS_JS → true (Insertion B).
      // When:  type({text:"hello world", ref:"@e1"}).execute() is called.
      // Then:  returned envelope is {ok:true, …}.
      //   AND: editorJsCallLog.length===3 (pre-loop[0] + Insertion C first[1] + Insertion C second[2]).
      //   AND: focusJsCallLog.length===1 (FOCUS_JS once — Insertion B).
      const { session, editorJsCallLog, focusJsCallLog } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [
          JSON.stringify({ present: true, editorText: "" }),             // editorJsQueue[0]: Insertion A
          JSON.stringify({ present: true, editorText: "hello worl" }),   // editorJsQueue[1]: Insertion C first (mismatch)
          JSON.stringify({ present: true, editorText: "hello world" }),  // editorJsQueue[2]: Insertion C second (match)
        ],
        focusJsResult: true,
      });
      await session.getClient().snapshot();
      const tool = makeTypeTool(session);
      const result = await tool.execute(
        { text: "hello world", ref: "@e1" },
        { toolCallId: "t-readback5", messages: [], abortSignal },
      );

      assert.equal(result.ok, true, "T-ReadBack.5: result must be ok:true (bounded re-probe matched)");

      // EDITOR_JS called exactly 3 times (pre-loop + first post + second post).
      // This count is over FEED_COMPOSER_EDITOR_JS payload SPECIFICALLY — robust to
      // any interleaved FOCUS_JS + REACT_SAFE_CLEAR evaluates (they route to other logs).
      assert.equal(
        editorJsCallLog.length,
        3,
        "T-ReadBack.5: FEED_COMPOSER_EDITOR_JS must be called exactly 3 times (pre-loop[0] + Insertion C first[1] + Insertion C second-after-wait[2])",
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
      //        editorJsQueue[1] → {present:true, editorText:""} (Insertion C first: mismatch).
      //        editorJsQueue[2] → {present:true, editorText:""} (Insertion C second after 120ms: still mismatch).
      //   AND: FEED_COMPOSER_FOCUS_JS → true (Insertion B).
      // When:  type({text:"hello", ref:"@e1"}).execute() is called.
      // Then:  result.ok===false, command:"type", error.kind==="runtime_error",
      //         error.message matches /composer body did not match|re-inspect/i.
      const { session } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [
          JSON.stringify({ present: true, editorText: "" }),   // editorJsQueue[0]: Insertion A
          JSON.stringify({ present: true, editorText: "" }),   // editorJsQueue[1]: Insertion C first (mismatch)
          JSON.stringify({ present: true, editorText: "" }),   // editorJsQueue[2]: Insertion C second (still mismatch)
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
      //        editorJsQueue[1] → {present:false, editorText:""} (Insertion C first: absent — fail-FAST).
      //        editorJsQueue[2]: intentionally absent (must NOT be called — absent-composer is fail-fast).
      //   AND: FEED_COMPOSER_FOCUS_JS → true (Insertion B).
      // When:  type({text:"hello", ref:"@e1"}).execute() is called.
      // Then:  result.ok===false, error.kind==="runtime_error",
      //         error.message matches /no longer present|composer.*closed/i.
      //   AND: editorJsCallLog.length===2 (Insertion A[0] + Insertion C first[1]; NO second probe).
      //        The absent-ghost path is fail-fast — ONLY present:true mismatches trigger re-probe.
      const { session, editorJsCallLog } = makeFeedComposerSession({
        entries: FEED_COMPOSER_ENTRIES,
        editorJsQueue: [
          JSON.stringify({ present: true, editorText: "" }),   // editorJsQueue[0]: Insertion A
          JSON.stringify({ present: false, editorText: "" }),  // editorJsQueue[1]: Insertion C (absent — fail-FAST)
          // editorJsQueue[2]: intentionally absent (must NOT be called)
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

      // EDITOR_JS called exactly 2 times: Insertion A[0] + Insertion C first[1].
      // NO second probe (fail-FAST — absent-composer does NOT trigger the 120ms re-probe).
      // Count is over FEED_COMPOSER_EDITOR_JS payload SPECIFICALLY — robust to FOCUS_JS + REACT_SAFE_CLEAR.
      assert.equal(
        editorJsCallLog.length,
        2,
        "T-ReadBack.7: FEED_COMPOSER_EDITOR_JS must be called exactly TWICE (Insertion A[0] + Insertion C first[1]; no second probe — absent-composer is fail-FAST)",
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
