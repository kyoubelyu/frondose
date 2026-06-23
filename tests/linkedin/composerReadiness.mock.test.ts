/**
 * P-POST-PUBLISH-2 — T-Helper.* composerReadiness unit tests (Step 5 — assertions filled).
 * P-POST-PUBLISH-4 — T-ClearHelper.1–.3 scaffolds (Step 2 outside-in TDD; filled at Step 5).
 * P-POST-PUBLISH-4 Step-5a — T-PostEnabledHelper.1–.3 (new: isFeedComposerPostButtonEnabled).
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
 * P-POST-PUBLISH-4 additions (Step 2 scaffold):
 *  - T-ClearHelper.1/2/3: clearFeedComposerEditorLive → true / false / false-on-throw.
 *    These tests use dynamic import inside each it() body to load clearFeedComposerEditorLive
 *    + FEED_COMPOSER_CLEAR_JS. Until Step 4 ships those exports, the dynamic import throws
 *    (or the named export is absent) and the tests reach assert.fail("TODO…") → RED on HEAD.
 *    This mirrors the focusFeedComposerEditorLive T-Helper.4/5/6 pattern exactly.
 *    The fake client harness is extended with a clearJsResult / clearJsShouldThrow option
 *    (analogous to the existing evaluateResult / evaluateShouldThrow options).
 *
 * Runner: node --import tsx --test --experimental-test-module-mocks --test-force-exit
 *         tests/linkedin/composerReadiness.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FEED_COMPOSER_EDITOR_JS,
  FEED_COMPOSER_FOCUS_JS,
  FEED_COMPOSER_POST_ENABLED_JS,
  composerTextMatches,
  focusFeedComposerEditorLive,
  isFeedComposerLiveInDOM,
  isFeedComposerPostButtonEnabled,
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
 * Dispatches fake client.evaluate by expr === FEED_COMPOSER_EDITOR_JS,
 * FEED_COMPOSER_FOCUS_JS, FEED_COMPOSER_POST_ENABLED_JS (imported constants — strict-equal).
 * Anything else (including REACT_SAFE_CLEAR_ACTIVE_INPUT_JS which is file-private
 * in type.ts and cannot be imported) returns false (safe default).
 *
 * Per-payload call logs: editorJsCallLog, focusJsCallLog, postEnabledJsCallLog.
 *
 * evaluateResult: the raw value returned when the expression matches the relevant payload.
 *   - For EDITOR_JS tests (T-Helper.1/2/3): a JSON-encoded string.
 *   - For FOCUS_JS tests (T-Helper.4/5/6): a boolean.
 *   - For CLEAR_JS tests (T-ClearHelper.*): a boolean (clearJsResult).
 *   - For POST_ENABLED_JS tests (T-PostEnabledHelper.*): a boolean (postEnabledJsResult).
 * evaluateShouldThrow: if true, Runtime.evaluate rejects for any call (T-Helper.3/6 / T-ClearHelper.3 / T-PostEnabledHelper.3).
 *
 * P-POST-PUBLISH-4: clearJsConstant + clearJsResult + clearJsShouldThrow are OPTIONAL.
 *   clearJsConstant: the FEED_COMPOSER_CLEAR_JS string loaded at test-body runtime via dynamic
 *     import (undefined until Step 4 ships the export). When provided, an additional dispatch
 *     branch fires on strict-equal match.
 *   clearJsResult: boolean returned by CLEAR_JS dispatch (default false).
 *   clearJsShouldThrow: if true, throw on CLEAR_JS dispatch (T-ClearHelper.3).
 *   clearJsCallLog: per-call log for CLEAR_JS dispatches.
 *
 * P-POST-PUBLISH-4 Step-5a: postEnabledJsResult for T-PostEnabledHelper.*.
 *   postEnabledJsResult: boolean returned by POST_ENABLED_JS dispatch (default true).
 */
function makeFakeClientWithEvaluate(opts: {
  evaluateResult?: string | boolean;
  evaluateShouldThrow?: boolean;
  // P-POST-PUBLISH-4 CLEAR_JS options:
  clearJsConstant?: string;
  clearJsResult?: boolean;
  clearJsShouldThrow?: boolean;
  // P-POST-PUBLISH-4 Step-5a POST_ENABLED_JS options:
  postEnabledJsResult?: boolean;
}): {
  client: CdpClient;
  editorJsCallLog: string[];
  focusJsCallLog: string[];
  clearJsCallLog: string[];
  postEnabledJsCallLog: string[];
} {
  const editorJsCallLog: string[] = [];
  const focusJsCallLog: string[] = [];
  const clearJsCallLog: string[] = [];
  const postEnabledJsCallLog: string[] = [];

  const fakeHandle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({ nodes: [] }),
    },
    Runtime: {
      evaluate: async (args: { expression: string }) => {
        // STRICT-EQUAL dispatch (no substring matching).
        if (opts.evaluateShouldThrow) {
          throw new Error("Fake evaluate error (T-Helper.3 / T-Helper.6 / T-ClearHelper.3 / T-PostEnabledHelper.3)");
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
        // P-POST-PUBLISH-4 Step-5a: POST_ENABLED_JS dispatch.
        if (args.expression === FEED_COMPOSER_POST_ENABLED_JS) {
          postEnabledJsCallLog.push("FEED_COMPOSER_POST_ENABLED_JS");
          return { result: { value: opts.postEnabledJsResult ?? true } };
        }
        // P-POST-PUBLISH-4: CLEAR_JS dispatch (when clearJsConstant is provided and matches).
        // clearJsConstant is loaded via dynamic import inside each T-ClearHelper.* test body.
        if (opts.clearJsConstant !== undefined && args.expression === opts.clearJsConstant) {
          clearJsCallLog.push("FEED_COMPOSER_CLEAR_JS");
          if (opts.clearJsShouldThrow) throw new Error("Fake CLEAR_JS throw (T-ClearHelper.3)");
          return { result: { value: opts.clearJsResult ?? false } };
        }
        // Anything else (non-matched): safe default false.
        return { result: { value: false } };
      },
    },
    DOM: {
      getDocument: async (_args: unknown) => ({ root: { nodeId: 1 } }),
      querySelectorAll: async (_args: unknown) => ({ nodeIds: [] }),
      scrollIntoViewIfNeeded: async (_arg: unknown) => {},
      getBoxModel: async (_args: unknown) => ({ model: { border: FAKE_BORDER } }),
    },
    Input: {
      dispatchMouseEvent: async () => {},
      dispatchKeyEvent: async () => {},
      insertText: async () => {},
    },
  };

  return { client: CdpClient.fromHandle(fakeHandle), editorJsCallLog, focusJsCallLog, clearJsCallLog, postEnabledJsCallLog };
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

// ---------------------------------------------------------------------------
// P-POST-PUBLISH-4 — T-ClearHelper.1–.3 (Step 2 scaffolds; outside-in TDD)
//
// COMPILE APPROACH: clearFeedComposerEditorLive + FEED_COMPOSER_CLEAR_JS are loaded via
// dynamic import INSIDE each it() body. Until Step 4 ships the named exports, the dynamic
// import resolves the module (composerReadiness.ts exists) but the named export is absent,
// so `mod.clearFeedComposerEditorLive` is undefined and `mod.FEED_COMPOSER_CLEAR_JS` is
// undefined. Each test body then reaches assert.fail("TODO…") and FAILS → RED on HEAD.
// After Step 4 adds the exports, the dynamic import resolves them and tests become fillable
// at Step 5. No static import of missing exports; no TS2307; file compiles clean on HEAD.
//
// Pattern mirrors T-Helper.4/5/6 (focusFeedComposerEditorLive) exactly:
//   T-ClearHelper.1 → evaluate returns true  → clearFeedComposerEditorLive resolves true
//   T-ClearHelper.2 → evaluate returns false → clearFeedComposerEditorLive resolves false
//   T-ClearHelper.3 → evaluate throws        → clearFeedComposerEditorLive resolves false (fail-closed)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T-ClearHelper.1 — clearFeedComposerEditorLive: evaluate returns true → resolves true
// ---------------------------------------------------------------------------

describe("clearFeedComposerEditorLive — returns true when evaluate(FEED_COMPOSER_CLEAR_JS) returns true", () => {
  it(
    "T-ClearHelper.1: when evaluate returns boolean true for FEED_COMPOSER_CLEAR_JS, resolves true",
    { timeout: 5000 },
    async () => {
      // Given: fake CdpClient whose evaluate returns boolean true when invoked with
      //        FEED_COMPOSER_CLEAR_JS (strict-equal dispatch, constant loaded via dynamic import).
      // When:  clearFeedComposerEditorLive(client) is awaited.
      // Then:  the result is true.
      try {
        const spec = "../../src/linkedin/composerReadiness.js";
        const mod = await import(spec) as Record<string, unknown>;
        const clearFn = mod["clearFeedComposerEditorLive"] as
          | ((client: unknown) => Promise<boolean>)
          | undefined;
        const clearJs = mod["FEED_COMPOSER_CLEAR_JS"] as string | undefined;
        if (typeof clearFn !== "function" || typeof clearJs !== "string") {
          assert.fail(
            "TODO Step 5: clearFeedComposerEditorLive + FEED_COMPOSER_CLEAR_JS not yet exported " +
            "from composerReadiness.ts (Step 4 pending). After Step 4, fill: " +
            "makeFakeClientWithEvaluate({clearJsConstant:FEED_COMPOSER_CLEAR_JS, clearJsResult:true}) → " +
            "clearFeedComposerEditorLive(client) resolves true.",
          );
        }
        const { client } = makeFakeClientWithEvaluate({
          clearJsConstant: clearJs,
          clearJsResult: true,
        });
        const result = await clearFn(client);
        assert.equal(result, true, "T-ClearHelper.1: clearFeedComposerEditorLive must resolve true when evaluate returns true");
      } catch (err) {
        // Re-throw assert failures; catch only module-resolution errors (missing export).
        if (err instanceof assert.AssertionError) throw err;
        assert.fail(
          "TODO Step 5: dynamic import of clearFeedComposerEditorLive failed (Step 4 pending). " +
          String(err),
        );
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-ClearHelper.2 — clearFeedComposerEditorLive: evaluate returns false → resolves false
// ---------------------------------------------------------------------------

describe("clearFeedComposerEditorLive — returns false when evaluate(FEED_COMPOSER_CLEAR_JS) returns false", () => {
  it(
    "T-ClearHelper.2: when evaluate returns boolean false (editor not found or clear failed), resolves false (not throw)",
    { timeout: 5000 },
    async () => {
      // Given: fake CdpClient whose evaluate returns boolean false for FEED_COMPOSER_CLEAR_JS.
      // When:  clearFeedComposerEditorLive(client) is awaited.
      // Then:  the result is false (NOT a throw — fail-closed means caller gets boolean not exception).
      try {
        const spec = "../../src/linkedin/composerReadiness.js";
        const mod = await import(spec) as Record<string, unknown>;
        const clearFn = mod["clearFeedComposerEditorLive"] as
          | ((client: unknown) => Promise<boolean>)
          | undefined;
        const clearJs = mod["FEED_COMPOSER_CLEAR_JS"] as string | undefined;
        if (typeof clearFn !== "function" || typeof clearJs !== "string") {
          assert.fail(
            "TODO Step 5: clearFeedComposerEditorLive + FEED_COMPOSER_CLEAR_JS not yet exported " +
            "(Step 4 pending). After Step 4, fill: " +
            "makeFakeClientWithEvaluate({clearJsConstant:FEED_COMPOSER_CLEAR_JS, clearJsResult:false}) → " +
            "clearFeedComposerEditorLive(client) resolves false.",
          );
        }
        const { client } = makeFakeClientWithEvaluate({
          clearJsConstant: clearJs,
          clearJsResult: false,
        });
        const result = await clearFn(client);
        assert.equal(result, false, "T-ClearHelper.2: clearFeedComposerEditorLive must resolve false when evaluate returns false");
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail(
          "TODO Step 5: dynamic import of clearFeedComposerEditorLive failed (Step 4 pending). " +
          String(err),
        );
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-ClearHelper.3 — clearFeedComposerEditorLive: evaluate THROWS → resolves false (fail-closed)
// ---------------------------------------------------------------------------

describe("clearFeedComposerEditorLive — fail-closed: evaluate throws → false (never re-throws)", () => {
  it(
    "T-ClearHelper.3: when client.evaluate throws, resolves false without re-throwing (mirrors focusFeedComposerEditorLive T-Helper.6 contract verbatim)",
    { timeout: 5000 },
    async () => {
      // Given: fake CdpClient whose evaluate THROWS for any expression (CDP error, etc.).
      // When:  clearFeedComposerEditorLive(client) is awaited.
      // Then:  the result is false (NEVER throws to caller — fail-closed pattern mirrors
      //        focusFeedComposerEditorLive; composerReadiness.ts:101-108 try/catch shape).
      try {
        const spec = "../../src/linkedin/composerReadiness.js";
        const mod = await import(spec) as Record<string, unknown>;
        const clearFn = mod["clearFeedComposerEditorLive"] as
          | ((client: unknown) => Promise<boolean>)
          | undefined;
        const clearJs = mod["FEED_COMPOSER_CLEAR_JS"] as string | undefined;
        if (typeof clearFn !== "function" || typeof clearJs !== "string") {
          assert.fail(
            "TODO Step 5: clearFeedComposerEditorLive + FEED_COMPOSER_CLEAR_JS not yet exported " +
            "(Step 4 pending). After Step 4, fill: " +
            "makeFakeClientWithEvaluate({clearJsConstant:FEED_COMPOSER_CLEAR_JS, evaluateShouldThrow:true}) → " +
            "clearFeedComposerEditorLive(client) resolves false (catch swallows the throw).",
          );
        }
        const { client } = makeFakeClientWithEvaluate({
          clearJsConstant: clearJs,
          evaluateShouldThrow: true,
        });
        const result = await clearFn(client);
        assert.equal(result, false, "T-ClearHelper.3: clearFeedComposerEditorLive must resolve false on throw (fail-closed)");
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail(
          "TODO Step 5: dynamic import of clearFeedComposerEditorLive failed (Step 4 pending). " +
          String(err),
        );
      }
    },
  );
});

// ---------------------------------------------------------------------------
// P-POST-PUBLISH-4 Step-5a — T-PostEnabledHelper.1–.3
//
// Helper-level tests for isFeedComposerPostButtonEnabled (Fix 2).
// Mirror the existing T-Helper.4/5/6 pattern exactly (focusFeedComposerEditorLive).
// FEED_COMPOSER_POST_ENABLED_JS and isFeedComposerPostButtonEnabled are statically
// imported (both exported from Step 4 onward).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T-PostEnabledHelper.1 — isFeedComposerPostButtonEnabled: evaluate returns true → resolves true
// ---------------------------------------------------------------------------

describe("isFeedComposerPostButtonEnabled — returns true when evaluate(FEED_COMPOSER_POST_ENABLED_JS) returns true", () => {
  it(
    "T-PostEnabledHelper.1: when evaluate returns boolean true for FEED_COMPOSER_POST_ENABLED_JS, resolves true",
    { timeout: 5000 },
    async () => {
      // Given: fake CdpClient whose evaluate returns boolean true when invoked with
      //        FEED_COMPOSER_POST_ENABLED_JS (strict-equal dispatch).
      // When:  isFeedComposerPostButtonEnabled(client) is awaited.
      // Then:  the result is true.
      const { client, postEnabledJsCallLog } = makeFakeClientWithEvaluate({
        postEnabledJsResult: true,
      });
      const result = await isFeedComposerPostButtonEnabled(client);
      assert.equal(result, true, "T-PostEnabledHelper.1: isFeedComposerPostButtonEnabled must resolve true when evaluate returns true");
      assert.equal(postEnabledJsCallLog.length, 1, "T-PostEnabledHelper.1: FEED_COMPOSER_POST_ENABLED_JS must be called exactly once");
    },
  );
});

// ---------------------------------------------------------------------------
// T-PostEnabledHelper.2 — isFeedComposerPostButtonEnabled: evaluate returns false → resolves false
// ---------------------------------------------------------------------------

describe("isFeedComposerPostButtonEnabled — returns false when evaluate(FEED_COMPOSER_POST_ENABLED_JS) returns false", () => {
  it(
    "T-PostEnabledHelper.2: when evaluate returns boolean false (button absent or disabled), resolves false (not throw)",
    { timeout: 5000 },
    async () => {
      // Given: fake CdpClient whose evaluate returns boolean false for FEED_COMPOSER_POST_ENABLED_JS.
      // When:  isFeedComposerPostButtonEnabled(client) is awaited.
      // Then:  the result is false (NOT a throw — fail-closed means caller gets boolean not exception).
      const { client } = makeFakeClientWithEvaluate({ postEnabledJsResult: false });
      const result = await isFeedComposerPostButtonEnabled(client);
      assert.equal(result, false, "T-PostEnabledHelper.2: isFeedComposerPostButtonEnabled must resolve false when evaluate returns false");
    },
  );
});

// ---------------------------------------------------------------------------
// T-PostEnabledHelper.3 — isFeedComposerPostButtonEnabled: evaluate THROWS → resolves false (fail-closed)
// ---------------------------------------------------------------------------

describe("isFeedComposerPostButtonEnabled — fail-closed: evaluate throws → false (never re-throws)", () => {
  it(
    "T-PostEnabledHelper.3: when client.evaluate throws, resolves false without re-throwing (mirrors focusFeedComposerEditorLive T-Helper.6 contract verbatim)",
    { timeout: 5000 },
    async () => {
      // Given: fake CdpClient whose evaluate THROWS for any expression (CDP error, etc.).
      // When:  isFeedComposerPostButtonEnabled(client) is awaited.
      // Then:  the result is false (NEVER throws to caller — fail-closed pattern mirrors
      //        focusFeedComposerEditorLive / clearFeedComposerEditorLive try/catch).
      const { client } = makeFakeClientWithEvaluate({ evaluateShouldThrow: true });
      const result = await isFeedComposerPostButtonEnabled(client);
      assert.equal(result, false, "T-PostEnabledHelper.3: isFeedComposerPostButtonEnabled must resolve false on throw (fail-closed)");
    },
  );
});
