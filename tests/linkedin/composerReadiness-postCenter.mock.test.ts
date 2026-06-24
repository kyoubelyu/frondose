/**
 * P-POST-PUBLISH-7 Step 2 — Group A scaffold
 * T-Helper.1–4: getFeedComposerPostButtonCenterLive helper
 *
 * Gate: G-P7.helper
 *
 * COMPILE APPROACH: getFeedComposerPostButtonCenterLive + FEED_COMPOSER_POST_CENTER_JS
 * are loaded via dynamic import INSIDE each it() body. Until Step 4 ships those named
 * exports from composerReadiness.ts, the dynamic import resolves the module but the
 * named export is absent → assert.fail("TODO P7: …") → RED on HEAD.
 * Mirrors the T-ClearHelper.* pattern from composerReadiness.mock.test.ts exactly.
 *
 * All 4 tests FAIL on HEAD (correct RED). No production-code edits.
 *
 * Runner:
 *   node --import tsx --test --test-force-exit \
 *     tests/linkedin/composerReadiness-postCenter.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";

// Disable inter-tool pacing for the mock suite.
process.env.FRONDOSE_PACE_MIN_MS = "0";

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake CdpClient whose Runtime.evaluate:
 *   - returns evaluateResult (a JSON string) for any expression unless evaluateShouldThrow
 *   - if evaluateShouldThrow is true, throws for all calls
 *
 * Used only to drive getFeedComposerPostButtonCenterLive — no other CDP methods needed
 * (the function calls only client.evaluate with FEED_COMPOSER_POST_CENTER_JS).
 */
function makeFakeClientForPostCenter(opts: {
  evaluateResult?: string;
  evaluateShouldThrow?: boolean;
}): CdpClient {
  const fakeHandle = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => ({ nodes: [] }),
    },
    Runtime: {
      evaluate: async (_args: { expression: string }) => {
        if (opts.evaluateShouldThrow) {
          throw new Error("Fake evaluate throw (T-Helper.3 / T-Helper.4)");
        }
        return {
          result: {
            value: opts.evaluateResult ?? JSON.stringify(null),
          },
        };
      },
    },
    DOM: {
      getDocument: async () => ({ root: { nodeId: 1 } }),
      querySelectorAll: async () => ({ nodeIds: [] }),
      scrollIntoViewIfNeeded: async () => {},
      getBoxModel: async () => ({ model: { border: [0, 0, 10, 0, 10, 10, 0, 10] } }),
    },
    Input: {
      dispatchMouseEvent: async () => {},
      dispatchKeyEvent: async () => {},
      insertText: async () => {},
    },
  };
  return CdpClient.fromHandle(fakeHandle);
}

// ---------------------------------------------------------------------------
// T-Helper.1 — Returns coords when an enabled, in-dialog Post button exists
// ---------------------------------------------------------------------------

describe("getFeedComposerPostButtonCenterLive — returns {x,y} when enabled in-dialog Post button present", () => {
  it(
    "T-Helper.1: when evaluate returns JSON {cx:480, cy:320}, resolves {x:480, y:320}",
    { timeout: 5000 },
    async () => {
      // Given: fake CDP whose Runtime.evaluate returns JSON '{"cx":480,"cy":320}'
      //        (i.e. shadow-piercing deepFind found an enabled Post button inside a
      //        composer dialog and returned its viewport-center CSS-pixel coords).
      // When:  getFeedComposerPostButtonCenterLive(client) is called.
      // Then:  returns {x:480, y:320} (cx→x, cy→y unwrapping).
      try {
        const spec = "../../src/linkedin/composerReadiness.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["getFeedComposerPostButtonCenterLive"] as
          | ((client: unknown) => Promise<{ x: number; y: number } | null>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail(
            "TODO P7: getFeedComposerPostButtonCenterLive not yet exported from composerReadiness.ts " +
            "(Step 4 pending). After Step 4, fill: fake evaluate returns {cx:480,cy:320} → " +
            "fn(client) resolves {x:480, y:320}.",
          );
        }
        const client = makeFakeClientForPostCenter({
          evaluateResult: JSON.stringify({ cx: 480, cy: 320 }),
        });
        const result = await fn(client);
        // T-Helper.1: evaluate returns {cx:480,cy:320} → fn returns {x:480,y:320}
        assert.deepEqual(result, { x: 480, y: 320 }, `T-Helper.1: expected {x:480,y:320}, got ${JSON.stringify(result)}`);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Helper.1: dynamic import of getFeedComposerPostButtonCenterLive failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Helper.2 — Returns null when no Post button is present
// ---------------------------------------------------------------------------

describe("getFeedComposerPostButtonCenterLive — returns null when evaluate returns null", () => {
  it(
    "T-Helper.2: when evaluate returns JSON null, resolves null (no throw)",
    { timeout: 5000 },
    async () => {
      // Given: fake CDP whose Runtime.evaluate returns JSON 'null'
      //        (i.e. no enabled Post button found inside a composer dialog).
      // When:  getFeedComposerPostButtonCenterLive(client) is called.
      // Then:  returns null (does NOT throw — fail-closed contract mirrors isFeedComposerPostButtonEnabled).
      try {
        const spec = "../../src/linkedin/composerReadiness.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["getFeedComposerPostButtonCenterLive"] as
          | ((client: unknown) => Promise<{ x: number; y: number } | null>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail(
            "T-Helper.2: getFeedComposerPostButtonCenterLive not exported from composerReadiness.ts.",
          );
        }
        const client = makeFakeClientForPostCenter({ evaluateResult: JSON.stringify(null) });
        const result = await fn(client);
        // T-Helper.2: evaluate returns null → fn returns null
        assert.equal(result, null, `T-Helper.2: expected null, got ${JSON.stringify(result)}`);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Helper.2: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Helper.3 — Returns null when evaluate throws (fail-closed)
// ---------------------------------------------------------------------------

describe("getFeedComposerPostButtonCenterLive — fail-closed: evaluate throws → null (never re-throws)", () => {
  it(
    "T-Helper.3: when client.evaluate throws, resolves null without re-throwing",
    { timeout: 5000 },
    async () => {
      // Given: fake CDP whose Runtime.evaluate THROWS for any expression (CDP error, etc.).
      // When:  getFeedComposerPostButtonCenterLive(client) is called.
      // Then:  returns null (NEVER throws — mirrors isFeedComposerPostButtonEnabled fail-closed contract).
      try {
        const spec = "../../src/linkedin/composerReadiness.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["getFeedComposerPostButtonCenterLive"] as
          | ((client: unknown) => Promise<{ x: number; y: number } | null>)
          | undefined;
        if (typeof fn !== "function") {
          assert.fail(
            "T-Helper.3: getFeedComposerPostButtonCenterLive not exported from composerReadiness.ts.",
          );
        }
        const client = makeFakeClientForPostCenter({ evaluateShouldThrow: true });
        let threw = false;
        let result: { x: number; y: number } | null | undefined;
        try {
          result = await fn(client);
        } catch {
          threw = true;
        }
        // T-Helper.3: evaluate throws → fn returns null, never re-throws
        assert.equal(threw, false, "T-Helper.3: fn must not throw when evaluate throws");
        assert.equal(result, null, `T-Helper.3: expected null on throw, got ${JSON.stringify(result)}`);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Helper.3: dynamic import failed. " + String(err));
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-Helper.4 — Returns null for a Post button OUTSIDE a composer dialog
// ---------------------------------------------------------------------------

describe("getFeedComposerPostButtonCenterLive — returns null for Post button outside composer dialog", () => {
  it(
    "T-Helper.4: when FEED_COMPOSER_POST_CENTER_JS payload itself returns null (insideComposerDialog gate rejects feed-card Post button), resolves null",
    { timeout: 5000 },
    async () => {
      // Given: fake CDP whose Runtime.evaluate returns JSON null when the FEED_COMPOSER_POST_CENTER_JS
      //        payload fires (i.e. the JS payload's insideComposerDialog + deepFind found a "Post"
      //        button but it was NOT inside a composer dialog — e.g. a reaction "Post" on a feed card —
      //        so the payload returned null). This models the shadow-pierce + insideComposerDialog
      //        matcher from FEED_COMPOSER_POST_ENABLED_JS being preserved in the new payload.
      // When:  getFeedComposerPostButtonCenterLive(client) is called.
      // Then:  returns null (the insideComposerDialog gate prevents spurious coord matches).
      try {
        const spec = "../../src/linkedin/composerReadiness.js";
        const mod = await import(spec) as Record<string, unknown>;
        const fn = mod["getFeedComposerPostButtonCenterLive"] as
          | ((client: unknown) => Promise<{ x: number; y: number } | null>)
          | undefined;
        const postCenterJs = mod["FEED_COMPOSER_POST_CENTER_JS"] as string | undefined;
        if (typeof fn !== "function" || typeof postCenterJs !== "string") {
          assert.fail(
            "T-Helper.4: getFeedComposerPostButtonCenterLive + FEED_COMPOSER_POST_CENTER_JS not exported from composerReadiness.ts.",
          );
        }
        // T-Helper.4: structural pin — the payload MUST include the insideComposerDialog guard
        assert.ok(
          postCenterJs.includes("insideComposerDialog"),
          "T-Helper.4: FEED_COMPOSER_POST_CENTER_JS must contain 'insideComposerDialog' (shadow-pierce guard)",
        );
        // fn with evaluate→null resolves null (simulates insideComposerDialog=false)
        const client = makeFakeClientForPostCenter({ evaluateResult: JSON.stringify(null) });
        const result = await fn(client);
        assert.equal(result, null, `T-Helper.4: expected null when insideComposerDialog gate rejects, got ${JSON.stringify(result)}`);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        assert.fail("T-Helper.4: dynamic import failed. " + String(err));
      }
    },
  );
});
