/**
 * Phase native-port-S2-HARDEN — Step 5 (validator, Sonnet) — filled assertions
 *
 * The Step-2 scaffold has been filled with structural assertions for the two
 * composer predicate factories added during hardening.
 *
 * Covers §5 T-Predicate family:
 *   T-Predicate.1 — COMPOSER_POST_BUTTON_ENABLED_JS() JS-string shape
 *   T-Predicate.2 — COMPOSER_PRESENT_JS() JS-string shape
 *
 * These tests pin the STRUCTURAL SHAPE (substring matches, not byte-for-byte
 * snapshots) of the two new predicate factories added to
 * src/linkedin/logic/predicates/composer.ts in Step 4.  They catch accidental
 * future rewrites that remove the shadow-DOM traversal, the aria-disabled check,
 * or the JSON envelope shape the call-site parser expects.
 *
 * Runner:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/linkedin/action/predicates-composer.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Dynamic loader for the composer predicates module.
//
// COMPOSER_POST_BUTTON_ENABLED_JS and COMPOSER_PRESENT_JS are loaded dynamically
// so the assertions exercise the emitted JS-string shape without pinning a
// byte-for-byte snapshot.
// ---------------------------------------------------------------------------

const COMPOSER_SPEC = new URL("../../../src/linkedin/logic/predicates/composer.js", import.meta.url).href;

type PredicateFactory = (...args: unknown[]) => string;

async function loadComposerPredicates(): Promise<{
  COMPOSER_POST_BUTTON_ENABLED_JS: PredicateFactory;
  COMPOSER_PRESENT_JS: PredicateFactory;
}> {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic module access
  const mod = (await import(COMPOSER_SPEC)) as Record<string, any>;
  return {
    COMPOSER_POST_BUTTON_ENABLED_JS: mod.COMPOSER_POST_BUTTON_ENABLED_JS as PredicateFactory,
    COMPOSER_PRESENT_JS: mod.COMPOSER_PRESENT_JS as PredicateFactory,
  };
}

// ===========================================================================
// T-Predicate — predicate JS-string shape (small but catches accidental rewrites)
// ===========================================================================

describe("COMPOSER_POST_BUTTON_ENABLED_JS — post-button enabled predicate JS shape (T-Predicate.1)", () => {
  it(
    "T-Predicate.1: COMPOSER_POST_BUTTON_ENABLED_JS() returns a string containing " +
      "'deepFind', 'insideComposerDialog', 'aria-disabled', 'disabled', and shadow-piercing 'shadowRoot'",
    async () => {
      // Given: Step-4 adds COMPOSER_POST_BUTTON_ENABLED_JS to composer.ts (port of composerReadiness.ts:386-466).
      // When: the factory is called with no arguments (uses DEFAULT_COMPOSER_LABEL_PATTERN).
      // Then: the returned JS string contains each load-bearing structural substring:
      //   - 'deepFind'              → shadow-piercing element search is present
      //   - 'insideComposerDialog'  → dialog gate guards against feed-level Post button
      //   - 'aria-disabled'         → ARIA disabled check
      //   - '.disabled'             → DOM disabled property check
      //   - '.shadowRoot'           → shadow-DOM recursion is present
      const { COMPOSER_POST_BUTTON_ENABLED_JS } = await loadComposerPredicates();
      const js = COMPOSER_POST_BUTTON_ENABLED_JS();
      assert.equal(typeof js, "string", "factory must return a string");
      assert.ok(js.includes("deepFind"), "shadow-piercing deepFind traversal must be present");
      assert.ok(
        js.includes("insideComposerDialog"),
        "dialog gate guard must be present (prevents feed-level Post button match)",
      );
      assert.ok(js.includes("aria-disabled"), "ARIA disabled attribute check must be present");
      assert.ok(js.includes("disabled"), "DOM .disabled property check must be present");
      assert.ok(js.includes("shadowRoot"), "shadow-DOM recursion via shadowRoot must be present");
    },
  );
});

describe("COMPOSER_PRESENT_JS — composer-present predicate JS shape (T-Predicate.2)", () => {
  it(
    "T-Predicate.2: COMPOSER_PRESENT_JS() returns a string containing " +
      "'deepFind' and 'JSON.stringify({present' (the same JSON envelope shape as COMPOSER_EDITOR_JS / FEED_COMPOSER_LIVE_IN_DOM_JS)",
    async () => {
      // Given: Step-4 adds COMPOSER_PRESENT_JS to composer.ts (port of composerReadiness.ts:97-118 shape + deepFindPrelude).
      // When: the factory is called with no arguments (uses DEFAULT_COMPOSER_LABEL_PATTERN).
      // Then: the returned JS string contains:
      //   - 'deepFind'              → shadow-piercing element search is present
      //   - 'JSON.stringify({pres'  → JSON envelope shape matches what confirmComposerGone's JSON.parse expects
      //   - 'shadowRoot'            → shadow-DOM recursion is present
      const { COMPOSER_PRESENT_JS } = await loadComposerPredicates();
      const js = COMPOSER_PRESENT_JS();
      assert.equal(typeof js, "string", "factory must return a string");
      assert.ok(js.includes("deepFind"), "shadow-piercing deepFind traversal must be present");
      assert.ok(
        js.includes("JSON.stringify({present"),
        "JSON envelope shape matching confirmComposerGone parser must be present",
      );
      assert.ok(js.includes("shadowRoot"), "shadow-DOM recursion via shadowRoot must be present");
    },
  );
});

// Suppress unused-variable warning for the loader.
void loadComposerPredicates;
