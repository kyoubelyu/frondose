/**
 * P-POST-PUBLISH-2 — T-Helper.* composerReadiness unit tests (Step 5 — assertions filled).
 *
 * Step-5 change vs Step-3a:
 *  - Assertion bodies filled for all 7 tests (T-Helper.1 – T-Helper.7).
 *  - Harness switched from positional/substring dispatch to STRICT-EQUAL constant import
 *    (NIT fix per Step-5 dispatch): import FEED_COMPOSER_EDITOR_JS + FEED_COMPOSER_FOCUS_JS
 *    from the real module and dispatch by expr === constant. Anything else (non-matched)
 *    returns false (safe default). This eliminates the el.focus() substring fragility and
 *    any false comment claiming substring-uniqueness.
 *  - T-Helper.1: asserts {present:true, editorText:"hello"} with NO editorBackendNodeId field.
 *  - T-Helper.2: asserts {present:false, editorText:""} without throw.
 *  - T-Helper.3: asserts {present:false, editorText:""} on throw (fail-closed).
 *  - T-Helper.4: asserts focusFeedComposerEditorLive resolves true when FOCUS_JS returns true.
 *  - T-Helper.5: asserts resolves false (not throw) when FOCUS_JS returns false.
 *  - T-Helper.6: asserts resolves false on throw (fail-closed).
 *  - T-Helper.7: exhaustive composerTextMatches matrix.
 *
 * Runner: node --import tsx --test --experimental-test-module-mocks --test-force-exit
 *         tests/linkedin/composerReadiness.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FEED_COMPOSER_EDITOR_JS,
  FEED_COMPOSER_FOCUS_JS,
  composerTextMatches,
  focusFeedComposerEditorLive,
  isFeedComposerLiveInDOM,
} from "../../src/linkedin/composerReadiness.js";
import { CdpClient } from "../../src/cdp/client.js";

// Disable inter-tool pacing for the mock suite.
process.env.FRONDOSE_PACE_MIN_MS = "0";

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

const FAKE_BORDER = [0, 0, 10, 0, 10, 10, 0, 10]; // center: x=5, y=5

/**
 * STRICT-EQUAL HARNESS (Step-5 NIT fix):
 *
 * Dispatches fake client.evaluate by expr === FEED_COMPOSER_EDITOR_JS or
 * expr === FEED_COMPOSER_FOCUS_JS (imported constants — strict-equal, no substring).
 * Anything else (including REACT_SAFE_CLEAR_ACTIVE_INPUT_JS which is file-private
 * in type.ts and cannot be imported) returns false (safe default).
 *
 * Per-payload call logs: editorJsCallLog (for EDITOR_JS calls), focusJsCallLog
 * (for FOCUS_JS calls). A combined callLogAll is available for debugging.
 *
 * evaluateResult: the raw value returned when the expression matches the relevant payload.
 *   - For EDITOR_JS tests (T-Helper.1/2/3): a JSON-encoded string.
 *   - For FOCUS_JS tests (T-Helper.4/5/6): a boolean.
 * evaluateShouldThrow: if true, Runtime.evaluate rejects for any call (T-Helper.3/6).
 */
function makeFakeClientWithEvaluate(opts: {
  evaluateResult?: string | boolean;
  evaluateShouldThrow?: boolean;
}): {
  client: CdpClient;
  editorJsCallLog: string[];
  focusJsCallLog: string[];
} {
  const editorJsCallLog: string[] = [];
  const focusJsCallLog: string[] = [];

  const fakeHandle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({ nodes: [] }),
    },
    Runtime: {
      evaluate: async (args: { expression: string }) => {
        // STRICT-EQUAL dispatch (no substring matching).
        if (opts.evaluateShouldThrow) {
          throw new Error("Fake evaluate error (T-Helper.3 / T-Helper.6)");
        }
        if (args.expression === FEED_COMPOSER_EDITOR_JS) {
          editorJsCallLog.push("FEED_COMPOSER_EDITOR_JS");
          return {
            result: {
              value: opts.evaluateResult ?? JSON.stringify({ present: false, editorText: "" }),
            },
          };
        }
        if (args.expression === FEED_COMPOSER_FOCUS_JS) {
          focusJsCallLog.push("FEED_COMPOSER_FOCUS_JS");
          return { result: { value: opts.evaluateResult ?? false } };
        }
        // Anything else (non-matched): safe default false.
        return { result: { value: false } };
      },
    },
    DOM: {
      getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (_args: unknown) => ({ nodeIds: [] }),
      getBoxModel: async (_args: unknown) => ({ model: { border: FAKE_BORDER } }),
    },
    Input: {
      dispatchMouseEvent: async () => {},
      dispatchKeyEvent: async () => {},
      insertText: async () => {},
    },
  };

  return { client: CdpClient.fromHandle(fakeHandle), editorJsCallLog, focusJsCallLog };
}

// ---------------------------------------------------------------------------
// T-Helper.1 — isFeedComposerLiveInDOM: present:true (CHANGED — no editorBackendNodeId)
// ---------------------------------------------------------------------------

describe("isFeedComposerLiveInDOM — present:true when composer visible in live DOM", () => {
  it(
    "T-Helper.1: when evaluate returns {present:true, editorText:'hello'}, resolves {present:true, editorText:'hello'} with NO editorBackendNodeId field",
    { timeout: 5000 },
    async () => {
      // Given: fake client.evaluate returns JSON {present:true, editorText:"hello"} when
      //        called with FEED_COMPOSER_EDITOR_JS (strict-equal dispatch).
      //        [REV-S3a Finding 3] The helper does NOT call DOM.querySelectorAll /
      //        DOM.describeNode — focus is focusFeedComposerEditorLive's job.
      // When:  isFeedComposerLiveInDOM(client) is called.
      // Then:  resolves to {present:true, editorText:"hello"} with NO editorBackendNodeId.
      const { client } = makeFakeClientWithEvaluate({
        evaluateResult: JSON.stringify({ present: true, editorText: "hello" }),
      });
      const result = await isFeedComposerLiveInDOM(client);
      assert.equal(result.present, true);
      assert.equal(result.editorText, "hello");
      assert.equal(
        "editorBackendNodeId" in result,
        false,
        "ComposerLiveProbeResult must NOT have editorBackendNodeId field (REV-S3a Finding 3)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Helper.2 — isFeedComposerLiveInDOM: present:false (UNCHANGED)
// ---------------------------------------------------------------------------

describe("isFeedComposerLiveInDOM — present:false when no composer in live DOM", () => {
  it(
    "T-Helper.2: when evaluate returns {present:false}, resolves {present:false, editorText:''} without throwing",
    { timeout: 5000 },
    async () => {
      // Given: fake client.evaluate returns JSON {present:false} for FEED_COMPOSER_EDITOR_JS.
      // When:  isFeedComposerLiveInDOM(client) is called.
      // Then:  resolves to {present:false, editorText:""} and does NOT throw.
      const { client } = makeFakeClientWithEvaluate({
        evaluateResult: JSON.stringify({ present: false, editorText: "" }),
      });
      const result = await isFeedComposerLiveInDOM(client);
      assert.equal(result.present, false);
      assert.equal(result.editorText, "");
    },
  );
});

// ---------------------------------------------------------------------------
// T-Helper.3 — isFeedComposerLiveInDOM: fail-closed (UNCHANGED)
// ---------------------------------------------------------------------------

describe("isFeedComposerLiveInDOM — fail-closed: evaluate throws → present:false", () => {
  it(
    "T-Helper.3: when client.evaluate throws, resolves {present:false, editorText:''} without re-throwing",
    { timeout: 5000 },
    async () => {
      // Given: fake client.evaluate THROWS for any expression.
      // When:  isFeedComposerLiveInDOM(client) is called.
      // Then:  resolves to {present:false, editorText:""} (fail-closed, NEVER throws to caller).
      const { client } = makeFakeClientWithEvaluate({ evaluateShouldThrow: true });
      const result = await isFeedComposerLiveInDOM(client);
      assert.equal(result.present, false);
      assert.equal(result.editorText, "");
    },
  );
});

// ---------------------------------------------------------------------------
// T-Helper.4 — focusFeedComposerEditorLive: happy path → true (NEW)
// ---------------------------------------------------------------------------

describe("focusFeedComposerEditorLive — returns true when editor found and focused", () => {
  it(
    "T-Helper.4: when evaluate returns true (FEED_COMPOSER_FOCUS_JS succeeded), resolves true",
    { timeout: 5000 },
    async () => {
      // Given: fake client.evaluate returns boolean true when invoked with FEED_COMPOSER_FOCUS_JS
      //        (strict-equal dispatch — the focus payload re-runs the same matcher in-page and
      //        calls .focus() — all in ONE evaluate call, no marker-lifetime race).
      // When:  focusFeedComposerEditorLive(client) is called.
      // Then:  resolves to true.
      const { client, focusJsCallLog } = makeFakeClientWithEvaluate({ evaluateResult: true });
      const result = await focusFeedComposerEditorLive(client);
      assert.equal(result, true);
      assert.equal(focusJsCallLog.length, 1, "FEED_COMPOSER_FOCUS_JS must have been called exactly once");
    },
  );
});

// ---------------------------------------------------------------------------
// T-Helper.5 — focusFeedComposerEditorLive: absent/failed → false (NEW)
// ---------------------------------------------------------------------------

describe("focusFeedComposerEditorLive — returns false when editor absent or focus failed", () => {
  it(
    "T-Helper.5: when evaluate returns false (editor not found or .focus() returned false), resolves false (not throw)",
    { timeout: 5000 },
    async () => {
      // Given: fake client.evaluate returns boolean false (no matching editor in DOM or .focus() failed).
      // When:  focusFeedComposerEditorLive(client) is called.
      // Then:  resolves to false (NOT a throw — fail-closed means caller gets boolean not exception).
      const { client } = makeFakeClientWithEvaluate({ evaluateResult: false });
      const result = await focusFeedComposerEditorLive(client);
      assert.equal(result, false);
    },
  );
});

// ---------------------------------------------------------------------------
// T-Helper.6 — focusFeedComposerEditorLive: fail-closed (throw → false) (NEW)
// ---------------------------------------------------------------------------

describe("focusFeedComposerEditorLive — fail-closed: evaluate throws → false", () => {
  it(
    "T-Helper.6: when client.evaluate throws, resolves false without re-throwing",
    { timeout: 5000 },
    async () => {
      // Given: fake client.evaluate THROWS for any expression (CDP error, network error, etc.).
      // When:  focusFeedComposerEditorLive(client) is called.
      // Then:  resolves to false (NEVER throws to caller — fail-closed pattern mirrors
      //        isFeedComposerLiveInDOM; Insertion B's fallback branch can be a simple if(!focused)).
      const { client } = makeFakeClientWithEvaluate({ evaluateShouldThrow: true });
      const result = await focusFeedComposerEditorLive(client);
      assert.equal(result, false);
    },
  );
});

// ---------------------------------------------------------------------------
// T-Helper.7 — composerTextMatches: full negative/positive matrix (NEW)
// Supersedes T-TextMatch.1/3/4; T-TextMatch.2 is retained as T-ReadBack.2 in type-composerReadiness.
// ---------------------------------------------------------------------------

describe("composerTextMatches — negative/positive matrix pinning Frondose whitespace-deviation", () => {
  it(
    "T-Helper.7: full matrix — missing space is mismatch, run-of-spaces collapses, newlines preserved, trim+prefix rules",
    { timeout: 5000 },
    async () => {
      // Given: composerTextMatches per plan §6.1 (NFC + CRLF→LF + strip trailing \n + [ \t]+ → single
      //        space + trim()); NOTE: newlines are NOT collapsed (intentional preservation).
      // When:  each pair is tested.
      // Then:  all assertions in the matrix hold (Finding 8 pins).
      const LONG_2000_CHAR = "a".repeat(2000);

      // Finding 8 pin: a missing space is still a mismatch (collapse is RUNS of whitespace, not removal).
      assert.equal(
        composerTextMatches("ab", "a b"),
        false,
        'composerTextMatches("ab", "a b") must be false — missing space is a meaningful mismatch',
      );

      // Run of multiple internal spaces collapses to one (Frondose deviation for LinkedIn contenteditable).
      assert.equal(
        composerTextMatches("a b", "a  b"),
        true,
        'composerTextMatches("a b", "a  b") must be true — run of spaces collapses to one',
      );

      // Internal newlines preserved: \n in both → match.
      assert.equal(
        composerTextMatches("hello\nworld", "hello\nworld"),
        true,
        'composerTextMatches("hello\\nworld", "hello\\nworld") must be true — internal newlines preserved',
      );

      // Internal newline vs space: a real mismatch (newline NOT collapsed to space).
      assert.equal(
        composerTextMatches("hello\nworld", "hello world"),
        false,
        'composerTextMatches("hello\\nworld", "hello world") must be false — newline is NOT a space',
      );

      // Trailing newline stripped: "hello\n" observed → matches "hello".
      assert.equal(
        composerTextMatches("hello", "hello\n"),
        true,
        'composerTextMatches("hello", "hello\\n") must be true — trailing newline stripped',
      );

      // Leading/trailing whitespace stripped (Frondose deviation vs mai-linkedin).
      assert.equal(
        composerTextMatches("  hello  ", "hello"),
        true,
        'composerTextMatches("  hello  ", "hello") must be true — leading/trailing whitespace stripped via trim()',
      );

      // >1000-char prefix rule: observed must startWith the first 200 chars of normalized intended.
      assert.equal(
        composerTextMatches(LONG_2000_CHAR, LONG_2000_CHAR.slice(0, 200) + "rest-differs"),
        true,
        "composerTextMatches(LONG_2000_CHAR, ...) must be true — >1000-char prefix rule: observed startsWith first 200 of intended",
      );
    },
  );
});
