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

// ---------------------------------------------------------------------------
// P-POST-PUBLISH-10 Step 2 — T-Regex.1–.4 (TARGET 2a label tolerance scaffold)
//
// Tests for the loosened FEED_START_A_POST_CENTER_JS regex (plan §3c TARGET 2a):
//   Current (HEAD): const START_RE = /^Start a post$/i;   ← exact-anchored
//   Target (P10):   const START_RE = /^(start|create)\s+a\s+post\b/i;  ← word-boundary
//
// These tests FAIL on HEAD because the current /^Start a post$/i regex:
//   - T-Regex.1: "Start a post" → passes on HEAD (but test scaffolded to confirm it still passes)
//   - T-Regex.2: "Start a post, Kyoube" → FAILS on HEAD ($ anchor blocks trailing comma+name)
//   - T-Regex.3: "Create a post" → FAILS on HEAD (Start-only)
//   - T-Regex.4: "Start a poll" → passes on HEAD (but the failing NEW tests above ensure
//                the scaffold is genuinely RED before the regex fix lands)
//
// HOW THE REGEX IS EXERCISED: FEED_START_A_POST_CENTER_JS is a JS string injected via
// Runtime.evaluate. We eval the JS string in-process using a Node.js Function constructor
// with a stub document that simulates the LinkedIn DOM (one button with the given aria-label).
// This mirrors what the browser would execute and exercises the real regex inside the string.
// Pattern: build a minimal stub-document with a visible button, run the JS string as a Function,
// assert the return value is non-null (match) or null (no match).
//
// Import: FEED_START_A_POST_CENTER_JS is statically imported from composerReadiness.js.
// On HEAD, T-Regex.2 and T-Regex.3 FAIL (null returned by the exact regex).
// T-Regex.1 and T-Regex.4 pass on HEAD AND after P10 (confirming no regression).
// ---------------------------------------------------------------------------

// Stub-document builder: creates a minimal DOM-like object with a single visible button.
// The button's aria-label is set to the provided label string.
// Returned stub is used as the `document` global when invoking FEED_START_A_POST_CENTER_JS.
function makeStubDocument(ariaLabel: string): Record<string, unknown> {
  const el: Record<string, unknown> = {
    tagName: "BUTTON",
    getAttribute: (attr: string) => {
      if (attr === "aria-label") return ariaLabel;
      if (attr === "role") return "button";
      if (attr === "aria-labelledby") return null;
      if (attr === "aria-hidden") return null;
      if (attr === "title") return null;
      if (attr === "disabled") return null;
      return null;
    },
    hasAttribute: (attr: string) => attr === "aria-label",
    shadowRoot: null,
    disabled: false,
    innerText: "",
    textContent: "",
    closest: (_: string) => null,
    querySelectorAll: (_: string) => [el], // querySelectorAll('*') returns [el]
    getBoundingClientRect: () => ({
      left: 100,
      top: 200,
      width: 120,
      height: 40,
    }),
  };

  const root: Record<string, unknown> = {
    tagName: "DOCUMENT",
    querySelectorAll: (_: string) => [el],
    shadowRoot: null,
    getElementById: (_: string) => null,
  };

  // getComputedStyle returns a style indicating visible element
  const globalStubs = {
    document: root,
    getComputedStyle: (_: unknown) => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
    }),
    JSON,
  };

  return globalStubs;
}

// Invoke FEED_START_A_POST_CENTER_JS using a Function constructor with a stub document.
// Returns the parsed result: { cx, cy } on match, null on no-match.
function runFeedStartAPostJs(
  jsString: string,
  ariaLabel: string,
): { cx: number; cy: number } | null {
  const stubs = makeStubDocument(ariaLabel);
  // Wrap the IIFE in a function with the stubs as injected globals.
  // The JS string is an IIFE: (() => { ... })()
  // We inject document + getComputedStyle + JSON as locals overriding the undefined globals.
  // biome-ignore lint/security/noGlobalEval: intentional — testing JS string behavior in-process
  const wrappedFn = new Function(
    "document",
    "getComputedStyle",
    "JSON",
    `return ${jsString}`,
  );
  const raw = wrappedFn(stubs.document, stubs.getComputedStyle, stubs.JSON) as string | null;
  if (raw === null || raw === "null" || raw === undefined) return null;
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as {
      cx?: number;
      cy?: number;
    } | null;
    if (!parsed || typeof parsed.cx !== "number" || typeof parsed.cy !== "number") return null;
    return { cx: parsed.cx, cy: parsed.cy };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// T-Regex.1 — exact "Start a post" still matches after regex loosening
// ---------------------------------------------------------------------------

describe("FEED_START_A_POST_CENTER_JS — TARGET 2a label tolerance: exact 'Start a post' still matches (T-Regex.1)", () => {
  it(
    "T-Regex.1: when button aria-label==='Start a post', FEED_START_A_POST_CENTER_JS returns non-null coords (regression: must still match after /^(start|create)\\s+a\\s+post\\b/i loosening)",
    { timeout: 5000 },
    async () => {
      // Given: a DOM stub with one visible button aria-label="Start a post".
      // When:  FEED_START_A_POST_CENTER_JS is executed against the stub.
      // Then:  the return value is a non-null {cx, cy} object (the button was found).
      //        (This test PASSES on HEAD and MUST ALSO PASS after P10 — regression guard.)
      const mod = (await import("../../src/linkedin/composerReadiness.js")) as Record<string, unknown>;
      const jsString = mod["FEED_START_A_POST_CENTER_JS"] as string | undefined;
      if (typeof jsString !== "string") {
        assert.fail("TODO P10: T-Regex.1 — FEED_START_A_POST_CENTER_JS not exported (Step 4 pending or module load issue)");
      }
      const result = runFeedStartAPostJs(jsString, "Start a post");
      assert.ok(
        result !== null && typeof result.cx === "number" && typeof result.cy === "number",
        `T-Regex.1: 'Start a post' must match FEED_START_A_POST_CENTER_JS. Got: ${JSON.stringify(result)}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Regex.2 — personalized "Start a post, Kyoube" matches (FAILS on HEAD)
// ---------------------------------------------------------------------------

describe("FEED_START_A_POST_CENTER_JS — TARGET 2a label tolerance: 'Start a post, Kyoube' matches (T-Regex.2)", () => {
  it(
    "T-Regex.2: when button aria-label==='Start a post, Kyoube', FEED_START_A_POST_CENTER_JS returns non-null coords (FAILS on HEAD with /^Start a post$/i; passes after \\b loosening)",
    { timeout: 5000 },
    async () => {
      // Given: a DOM stub with one visible button aria-label="Start a post, Kyoube"
      //        (LinkedIn personalizes this label with the operator's first name).
      // When:  FEED_START_A_POST_CENTER_JS is executed against the stub.
      // Then:  the return value is a non-null {cx, cy} object (the button was found).
      //        This FAILS on HEAD because /^Start a post$/i has a $ that blocks "..., Kyoube".
      //        After P10 TARGET 2a: /^(start|create)\s+a\s+post\b/i matches the stem.
      const mod = (await import("../../src/linkedin/composerReadiness.js")) as Record<string, unknown>;
      const jsString = mod["FEED_START_A_POST_CENTER_JS"] as string | undefined;
      if (typeof jsString !== "string") {
        assert.fail("TODO P10: T-Regex.2 — FEED_START_A_POST_CENTER_JS not exported (Step 4 pending or module load issue)");
      }
      const result = runFeedStartAPostJs(jsString, "Start a post, Kyoube");
      assert.ok(
        result !== null && typeof result.cx === "number" && typeof result.cy === "number",
        `T-Regex.2: 'Start a post, Kyoube' must match FEED_START_A_POST_CENTER_JS after /^(start|create)\\s+a\\s+post\\b/i loosening. Got: ${JSON.stringify(result)}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Regex.3 — alternate verb "Create a post" matches (FAILS on HEAD)
// ---------------------------------------------------------------------------

describe("FEED_START_A_POST_CENTER_JS — TARGET 2a label tolerance: 'Create a post' matches (T-Regex.3)", () => {
  it(
    "T-Regex.3: when button aria-label==='Create a post', FEED_START_A_POST_CENTER_JS returns non-null coords (FAILS on HEAD with Start-only regex; passes after (start|create) group)",
    { timeout: 5000 },
    async () => {
      // Given: a DOM stub with one visible button aria-label="Create a post"
      //        (LinkedIn alternate phrasing in some locales/UI variants).
      // When:  FEED_START_A_POST_CENTER_JS is executed against the stub.
      // Then:  the return value is a non-null {cx, cy} object (the button was found).
      //        This FAILS on HEAD because /^Start a post$/i only accepts "Start" as the verb.
      //        After P10 TARGET 2a: /^(start|create)\s+a\s+post\b/i also accepts "create".
      const mod = (await import("../../src/linkedin/composerReadiness.js")) as Record<string, unknown>;
      const jsString = mod["FEED_START_A_POST_CENTER_JS"] as string | undefined;
      if (typeof jsString !== "string") {
        assert.fail("TODO P10: T-Regex.3 — FEED_START_A_POST_CENTER_JS not exported (Step 4 pending or module load issue)");
      }
      const result = runFeedStartAPostJs(jsString, "Create a post");
      assert.ok(
        result !== null && typeof result.cx === "number" && typeof result.cy === "number",
        `T-Regex.3: 'Create a post' must match FEED_START_A_POST_CENTER_JS after /^(start|create)\\s+a\\s+post\\b/i loosening. Got: ${JSON.stringify(result)}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Regex.4 — "Start a poll" does NOT match (must return null, both HEAD and P10)
// ---------------------------------------------------------------------------

describe("FEED_START_A_POST_CENTER_JS — TARGET 2a label tolerance: 'Start a poll' does NOT match (T-Regex.4)", () => {
  it(
    "T-Regex.4: when button aria-label==='Start a poll', FEED_START_A_POST_CENTER_JS returns null (false positive guard — 'poll' must NOT be caught by the /post\\b/ word-boundary)",
    { timeout: 5000 },
    async () => {
      // Given: a DOM stub with one visible button aria-label="Start a poll".
      //        This simulates an adjacent LinkedIn button that must NOT trigger the composer open.
      // When:  FEED_START_A_POST_CENTER_JS is executed against the stub.
      // Then:  the return value is null (button NOT found — regex does not match "poll" after \\b).
      //        This should PASS on HEAD (/^Start a post$/i clearly rejects "poll") AND after P10
      //        (/^(start|create)\s+a\s+post\b/i: "post" word boundary does not match "poll").
      //        (Test is a regression guard for the P10 regex loosening: \b correctly gates it.)
      const mod = (await import("../../src/linkedin/composerReadiness.js")) as Record<string, unknown>;
      const jsString = mod["FEED_START_A_POST_CENTER_JS"] as string | undefined;
      if (typeof jsString !== "string") {
        assert.fail("TODO P10: T-Regex.4 — FEED_START_A_POST_CENTER_JS not exported (Step 4 pending or module load issue)");
      }
      const result = runFeedStartAPostJs(jsString, "Start a poll");
      assert.equal(
        result,
        null,
        `T-Regex.4: 'Start a poll' must NOT match FEED_START_A_POST_CENTER_JS. Got: ${JSON.stringify(result)}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// P-POST-PUBLISH-10 Step 3a — T-Exact.1–.5 (REVISED 3a — F-1 BLOCKER: composerTextExact helper)
//
// Tests for the NEW exported helper `composerTextExact(intended, observed)` in
// src/linkedin/composerReadiness.ts (plan §3a-bis + §6d).
//
// `composerTextExact` uses the SAME normalization as `composerTextMatches`
// (via a shared private `normForCompare`: NFC + \r\n?→\n + strip trailing \n +
//  collapse [ \t]+ to single space + trim) but ends at strict === (no prefix branch).
//
// ALL FIVE TESTS FAIL ON HEAD because `composerTextExact` does not exist yet.
// They are loaded via dynamic import inside each it() body (same pattern as T-ClearHelper.*).
// After Step 4 ships the export, assertion bodies in T-Exact.1–.4 pass; T-Exact.5 is
// already-asserting (it re-runs composerTextMatches to confirm byte-identical semantics
// on the normForCompare refactor — composerTextMatches is statically imported).
//
// The load-bearing F-1 assertion is T-Exact.3:
//   composerTextExact("A".repeat(1500), "A".repeat(200)) MUST return FALSE
//   while composerTextMatches RETURNS TRUE for the same inputs (per T-Helper.7 above).
// This is the exact predicate that would have allowed the fast-path to publish a truncated
// post on the old plan; it MUST fail on the new exact-match helper.
// ---------------------------------------------------------------------------

describe(
  "composerTextExact — REVISED 3a F-1 helper: exact normalized equality (no prefix-tolerance branch) (T-Exact.1–.5)",
  () => {

    // T-Exact.1 — identical short strings → true
    it(
      "T-Exact.1: when intended==='hello' and observed==='hello', composerTextExact returns true",
      { timeout: 5000 },
      async () => {
        // Given: identical short strings "hello" / "hello".
        // When:  composerTextExact("hello", "hello") is called.
        // Then:  returns true (exact match after normForCompare applies NFC + collapse + trim).
        //        FAILS ON HEAD: composerTextExact does not exist (Step 4 pending).
        try {
          const mod = await import("../../src/linkedin/composerReadiness.js") as Record<string, unknown>;
          const exactFn = mod["composerTextExact"] as
            | ((intended: string, observed: string) => boolean)
            | undefined;
          if (typeof exactFn !== "function") {
            assert.fail(
              "TODO P10: T-Exact.1 — composerTextExact not yet exported from composerReadiness.ts " +
              "(Step 4 pending). After Step 4: composerTextExact('hello', 'hello') must return true.",
            );
          }
          const result = exactFn("hello", "hello");
          assert.equal(result, true, "T-Exact.1: composerTextExact('hello', 'hello') must return true");
        } catch (err) {
          if (err instanceof assert.AssertionError) throw err;
          assert.fail(`T-Exact.1: dynamic import failed (Step 4 pending). ${String(err)}`);
        }
      },
    );

    // T-Exact.2 — NFC + whitespace normalization applied identically to composerTextMatches
    it(
      "T-Exact.2: when intended==='café  hello\\r\\n' and observed==='café hello\\n', composerTextExact returns true (NFC + \\r\\n→\\n + trailing \\n stripped + spaces collapsed)",
      { timeout: 5000 },
      async () => {
        // Given: intended has a precomposed 'é' (NFC U+00E9) + double space + \r\n trailing;
        //        observed has a precomposed 'é' + single space + \n trailing.
        //        normForCompare applies: NFC (both 'é' → U+00E9 if not already); \r\n?→\n;
        //        \n+$ strip; [ \t]+ → " "; trim. Result for both: "café hello".
        // When:  composerTextExact("café  hello\r\n", "café hello\n") is called.
        // Then:  returns true.
        //        FAILS ON HEAD: composerTextExact does not exist (Step 4 pending).
        try {
          const mod = await import("../../src/linkedin/composerReadiness.js") as Record<string, unknown>;
          const exactFn = mod["composerTextExact"] as
            | ((intended: string, observed: string) => boolean)
            | undefined;
          if (typeof exactFn !== "function") {
            assert.fail(
              "TODO P10: T-Exact.2 — composerTextExact not yet exported from composerReadiness.ts " +
              "(Step 4 pending). After Step 4: normalization-equivalence check must pass.",
            );
          }
          // "café  hello\r\n" and "café hello\n" normalize identically via normForCompare
          const result = exactFn("café  hello\r\n", "café hello\n");
          assert.equal(result, true, "T-Exact.2: NFC + whitespace normalization must produce equal strings");
        } catch (err) {
          if (err instanceof assert.AssertionError) throw err;
          assert.fail(`T-Exact.2: dynamic import failed (Step 4 pending). ${String(err)}`);
        }
      },
    );

    // T-Exact.3 — long-draft (>1000 chars) prefix-only observed → FALSE (THE F-1 PIN)
    it(
      "T-Exact.3: when intended==='A'.repeat(1500) and observed==='A'.repeat(200), composerTextExact returns FALSE; composerTextMatches returns TRUE for same inputs (F-1 BLOCKER pin)",
      { timeout: 5000 },
      async () => {
        // Given: intended = "A".repeat(1500), observed = "A".repeat(200).
        //        composerTextMatches("A".repeat(1500), "A".repeat(200)) returns TRUE
        //        (the >1000-char prefix branch: observed starts with first 200 normalized chars).
        //        composerTextExact for the same inputs: normForCompare("A".repeat(1500)) is
        //        "A".repeat(1500) (no collapse/trim applies); normForCompare("A".repeat(200)) is
        //        "A".repeat(200). These are NOT equal → composerTextExact returns FALSE.
        // When:  composerTextExact("A".repeat(1500), "A".repeat(200)) is called.
        // Then:  returns FALSE. This is the LOAD-BEARING F-1 assertion at the helper layer.
        //        The contrast with composerTextMatches (which returns TRUE) is what makes the
        //        fast-path safe — only composerTextExact is used at the entry gate and readback.
        //        FAILS ON HEAD: composerTextExact does not exist (Step 4 pending).
        try {
          const mod = await import("../../src/linkedin/composerReadiness.js") as Record<string, unknown>;
          const exactFn = mod["composerTextExact"] as
            | ((intended: string, observed: string) => boolean)
            | undefined;
          if (typeof exactFn !== "function") {
            assert.fail(
              "TODO P10: T-Exact.3 — composerTextExact not yet exported from composerReadiness.ts " +
              "(Step 4 pending). After Step 4: composerTextExact('A'.repeat(1500), 'A'.repeat(200)) MUST return false " +
              "(while composerTextMatches returns true for the same inputs — the F-1 safety delta).",
            );
          }
          const LONG = "A".repeat(1500);
          const PREFIX = "A".repeat(200);
          // Assert composerTextExact rejects the prefix case (the F-1 BLOCKER fix)
          const exactResult = exactFn(LONG, PREFIX);
          assert.equal(exactResult, false,
            "T-Exact.3: composerTextExact('A'.repeat(1500), 'A'.repeat(200)) MUST return false " +
            "(exact-match; prefix not tolerated)");
          // Confirm composerTextMatches returns TRUE for the same inputs (cross-check that the
          // refactor did NOT accidentally change composerTextMatches semantics — T-Exact.5 covers this
          // more broadly, but this cite makes the F-1 safety delta explicit in T-Exact.3).
          const tolerantResult = composerTextMatches(LONG, PREFIX);
          assert.equal(tolerantResult, true,
            "T-Exact.3 cross-check: composerTextMatches('A'.repeat(1500), 'A'.repeat(200)) must STILL return true " +
            "(the prefix-tolerance branch in composerTextMatches is unchanged by the P10 refactor)");
        } catch (err) {
          if (err instanceof assert.AssertionError) throw err;
          assert.fail(`T-Exact.3: dynamic import failed (Step 4 pending). ${String(err)}`);
        }
      },
    );

    // T-Exact.4 — long-draft (>1000 chars) full match → TRUE
    it(
      "T-Exact.4: when intended===observed==='A'.repeat(1500), composerTextExact returns TRUE (full match on long draft)",
      { timeout: 5000 },
      async () => {
        // Given: intended = observed = "A".repeat(1500) (same long string).
        //        normForCompare produces the same result for both → strict === → true.
        // When:  composerTextExact("A".repeat(1500), "A".repeat(1500)) is called.
        // Then:  returns TRUE. This is the fast-path happy-path condition for long drafts.
        //        FAILS ON HEAD: composerTextExact does not exist (Step 4 pending).
        try {
          const mod = await import("../../src/linkedin/composerReadiness.js") as Record<string, unknown>;
          const exactFn = mod["composerTextExact"] as
            | ((intended: string, observed: string) => boolean)
            | undefined;
          if (typeof exactFn !== "function") {
            assert.fail(
              "TODO P10: T-Exact.4 — composerTextExact not yet exported from composerReadiness.ts " +
              "(Step 4 pending). After Step 4: composerTextExact('A'.repeat(1500), 'A'.repeat(1500)) must return true.",
            );
          }
          const LONG = "A".repeat(1500);
          const result = exactFn(LONG, LONG);
          assert.equal(result, true,
            "T-Exact.4: composerTextExact('A'.repeat(1500), 'A'.repeat(1500)) must return true " +
            "(full match on long draft)");
        } catch (err) {
          if (err instanceof assert.AssertionError) throw err;
          assert.fail(`T-Exact.4: dynamic import failed (Step 4 pending). ${String(err)}`);
        }
      },
    );

    // T-Exact.5 — shared normalization regression: composerTextMatches semantics unchanged after normForCompare refactor
    it(
      "T-Exact.5: composerTextMatches still passes the existing T-Helper.7 matrix cases after the normForCompare refactor (regression guard for the shared-normalizer restructure)",
      { timeout: 5000 },
      async () => {
        // Given: the normForCompare refactor (plan §3a-bis §6d) extracts the normalization from
        //        composerTextMatches into a private helper shared with composerTextExact. This
        //        restructure MUST NOT change composerTextMatches semantics (CLAUDE.md §1 Surgical Changes:
        //        "touch only what F-1 demands; do NOT silently tighten the established post-insert
        //        readback semantics"). This test re-asserts the T-Helper.7 matrix on the statically-
        //        imported composerTextMatches (imported at file top) to confirm byte-identical behavior.
        //        If composerTextMatches semantics changed, these assertions would fail.
        // When:  each composerTextMatches call from T-Helper.7 is re-run.
        // Then:  all assertions pass (byte-identical to T-Helper.7 results on HEAD).
        //        NOTE: this test is already-asserting (composerTextMatches is statically imported and
        //        passes on HEAD). It catches regressions introduced by the normForCompare refactor at Step 4.
        const LONG_2000_CHAR = "a".repeat(2000);

        // Missing space is still a mismatch
        assert.equal(composerTextMatches("ab", "a b"), false,
          "T-Exact.5 regression: composerTextMatches('ab', 'a b') must still be false after refactor");
        // Run of spaces still collapses
        assert.equal(composerTextMatches("a b", "a  b"), true,
          "T-Exact.5 regression: composerTextMatches('a b', 'a  b') must still be true");
        // Internal newlines still preserved
        assert.equal(composerTextMatches("hello\nworld", "hello\nworld"), true,
          "T-Exact.5 regression: composerTextMatches('hello\\nworld', 'hello\\nworld') must still be true");
        // Newline vs space still a mismatch
        assert.equal(composerTextMatches("hello\nworld", "hello world"), false,
          "T-Exact.5 regression: composerTextMatches('hello\\nworld', 'hello world') must still be false");
        // Trailing newline still stripped
        assert.equal(composerTextMatches("hello", "hello\n"), true,
          "T-Exact.5 regression: composerTextMatches('hello', 'hello\\n') must still be true");
        // Leading/trailing whitespace still trimmed
        assert.equal(composerTextMatches("  hello  ", "hello"), true,
          "T-Exact.5 regression: composerTextMatches('  hello  ', 'hello') must still be true");
        // >1000-char prefix rule still intact (the tolerance branch MUST NOT have been removed)
        assert.equal(
          composerTextMatches(LONG_2000_CHAR, LONG_2000_CHAR.slice(0, 200) + "rest-differs"),
          true,
          "T-Exact.5 regression: composerTextMatches >1000-char prefix rule must still hold after refactor",
        );
      },
    );

  },
);
