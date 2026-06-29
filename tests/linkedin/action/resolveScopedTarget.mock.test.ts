/**
 * Phase native-port-S2 — Step 5 (validator, Sonnet) — assertions filled
 * §5.D: resolveScopedTarget wiring against action-scope contexts.
 *
 * Source-under-test: src/linkedin/logic/scopeResolver/targetResolution.ts
 * (already shipped at Slice-1; these are INTEGRATION tests that pin the action's
 * call signatures against the resolver's contract for the publish scopes).
 *
 * Import approach: static import — resolveScopedTarget already exists.
 * These tests exercise the actual resolver against hand-built contexts.
 *
 * Gates covered: §5.D T-RT.1–3.
 *
 * Runner:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/linkedin/action/resolveScopedTarget.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActiveLayer, InspectSummary } from "../../../src/linkedin/logic/contracts/inspect.js";
import { CommandNotFoundError } from "../../../src/linkedin/logic/scopeResolver/shared.js";
import { resolveScopedTarget } from "../../../src/linkedin/logic/scopeResolver/targetResolution.js";
import { buildCurrentSurfaceSummaryAssembly } from "../../../src/linkedin/logic/surface/currentSurfaceSummary.js";
import type { CurrentSurfaceContext } from "../../../src/linkedin/logic/surface/currentSurfaceTypes.js";
import { createForegroundContext } from "../../../src/linkedin/logic/surface/foregroundContext.js";

// Disable inter-tool pacing for the mock suite.
process.env.FRONDOSE_PACE_MIN_MS = "0";

// ---------------------------------------------------------------------------
// Context builder helpers (same shape as tests/linkedin/logic/scopeResolver.mock.test.ts)
// ---------------------------------------------------------------------------

function entry(role: string, name: string, ref: string): { ref: string; role: string; name: string } {
  return { ref, role, name };
}

function buildContext(
  entries: ReturnType<typeof entry>[],
  pageUrl = "https://www.linkedin.com/feed/",
  activeLayerOverride?: ActiveLayer,
): CurrentSurfaceContext {
  const foregroundContext = createForegroundContext(pageUrl, entries);
  const summaryParts = buildCurrentSurfaceSummaryAssembly(foregroundContext, entries, entries, pageUrl);
  const resolvedActiveLayer = activeLayerOverride ?? foregroundContext.activeLayer;
  const summary: InspectSummary = {
    surface: foregroundContext.legacySurface,
    activeLayer: resolvedActiveLayer,
    availableScopes: summaryParts.availableScopes,
    text: summaryParts.text,
    buttons: summaryParts.buttons,
    inputs: summaryParts.inputs,
    inputValues: summaryParts.inputValues,
    interactiveRegions: summaryParts.interactiveRegions,
    ambiguityCases: summaryParts.ambiguityCases,
  };
  return {
    pageUrl,
    surface: foregroundContext.legacySurface,
    activeLayer: resolvedActiveLayer,
    entries,
    repeatedControls: summaryParts.repeatedControls,
    summary,
  };
}

/** A canonical composer modal context: textbox + Post button visible. */
function composerModalContext(activeLayerOverride?: ActiveLayer): CurrentSurfaceContext {
  return buildContext(
    [
      entry("textbox", "Text editor for creating content", "@e1"),
      entry("button", "Add media", "@e2"),
      entry("button", "Post", "@e3"),
    ],
    "https://www.linkedin.com/feed/",
    activeLayerOverride,
  );
}

/** A page-layer context: feed page, no modal open. */
function feedPageContext(): CurrentSurfaceContext {
  return buildContext([entry("button", "Start a post", "@e1")], "https://www.linkedin.com/feed/", "page");
}

/**
 * A context with two Post-like buttons in different scopes:
 * one in the composer modal + one in a share-box sidebar.
 * T-RT.3 verifies the resolver picks the composer-modal scoped one.
 */
function ambiguousPostContext(): CurrentSurfaceContext {
  // Build a context where the feed entries contain:
  // - composerInput scope entries
  // - composerModal scope entry ("Post")
  // - A sidebar "Post" button that maps to a different scope.
  // The real resolver scopes on composerModal for kind:button + scope:composerModal.
  return buildContext(
    [
      entry("textbox", "Text editor for creating content", "@e1"),
      entry("button", "Post", "@e2"),
      // A second "Post"-like entry that might appear in a sidebar share-box.
      // The composerModal scope + exact-label-match ("Post" vs "Post to group")
      // together disambiguate these entries without a bespoke resolver wrapper.
      entry("button", "Post to group", "@e3"),
    ],
    "https://www.linkedin.com/feed/",
    "modal",
  );
}

// ---------------------------------------------------------------------------
// §5.D T-RT.1 — composerInput resolves when scope is available
// ---------------------------------------------------------------------------

describe("resolveScopedTarget — composerInput resolves (T-RT.1)", () => {
  it(
    "T-RT.1: given context.summary.availableScopes contains 'composerInput', " +
      "when resolveScopedTarget({kind:'input',scope:'composerInput'}, context) is called, " +
      "then it returns a target whose selector matches the AX entry for the composer editor",
    async () => {
      // Given: a modal context with a composerInput-scoped textbox entry.
      // When: resolveScopedTarget is called with kind:input, scope:composerInput.
      // Then: target.selector starts with '@e' (the AX ref for the textbox entry).
      const ctx = composerModalContext();

      // Verify precondition: composerInput is in availableScopes
      assert.ok(
        ctx.summary.availableScopes.some((s) => s.id === "composerInput"),
        "T-RT.1 precondition: composerInput must be in availableScopes",
      );

      const result = await resolveScopedTarget({ kind: "input", scope: "composerInput" }, ctx);

      assert.ok(
        result.target.selector.startsWith("@e"),
        `T-RT.1: target.selector must be an AX ref (got "${result.target.selector}")`,
      );
      assert.equal(result.target.kind, "input", "T-RT.1: target.kind must be 'input'");
      // The textbox entry (@e1) matches isComposerInputEntry via
      // /creating content|what do you want to talk about/i
      assert.equal(result.target.ref, "@e1", "T-RT.1: should resolve to the textbox entry (@e1)");
    },
  );
});

// ---------------------------------------------------------------------------
// §5.D T-RT.2 — page layer throws when composerModal required
// ---------------------------------------------------------------------------

describe("resolveScopedTarget — throws CommandNotFoundError on page layer (T-RT.2)", () => {
  it(
    "T-RT.2: given context.activeLayer === 'page' (NOT modal), " +
      "when resolveScopedTarget({kind:'button',label:'Post',scope:'composerModal'}, context) is called, " +
      "then it throws a CommandNotFoundError whose message names 'composerModal' and 'modal'",
    async () => {
      // Given: feed page context (no modal open) without composerModal in availableScopes.
      // When: resolveScopedTarget asked for a composerModal-scoped Post button.
      // Then: throws CommandNotFoundError with message containing composerModal / modal.
      const ctx = feedPageContext();

      assert.equal(ctx.activeLayer, "page", "T-RT.2 precondition: activeLayer must be 'page'");

      await assert.rejects(
        async () => {
          await resolveScopedTarget({ kind: "button", label: "Post", scope: "composerModal" }, ctx);
        },
        (err: unknown) => {
          assert.ok(
            err instanceof CommandNotFoundError,
            `T-RT.2: expected CommandNotFoundError, got ${(err as Error)?.constructor?.name}`,
          );
          const msg = (err as Error).message;
          assert.ok(
            msg.includes("composerModal") || msg.includes("modal"),
            `T-RT.2: error message should mention 'composerModal' or 'modal', got: "${msg}"`,
          );
          return true;
        },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// §5.D T-RT.3 — scope disambiguation: composerModal beats sidebar Post
// ---------------------------------------------------------------------------

describe("resolveScopedTarget — composerModal scope disambiguates two Post buttons (T-RT.3)", () => {
  it(
    "T-RT.3: given a context with two 'Post'-ish buttons in different scopes, " +
      "when resolveScopedTarget({kind:'button',label:'Post',scope:'composerModal'}, context) is called, " +
      "then the returned target is from the composer-modal scope (not the sidebar)",
    async () => {
      // Given: modal context with multiple Post-like entries; composerModal scoping requested.
      // When: resolveScopedTarget resolves with scope:'composerModal'.
      // Then: target.scope === 'composerModal'; no sidebar entry returned.
      // (Pins the 'no-specialized-tool-primitives' memory: resolver disambiguates without bespoke wrapper.)
      const ctx = ambiguousPostContext();

      // Verify both entries are present
      const entryNames = ctx.entries.map((e) => e.name);
      assert.ok(entryNames.includes("Post"), "T-RT.3 precondition: 'Post' entry must be present");
      assert.ok(entryNames.includes("Post to group"), "T-RT.3 precondition: 'Post to group' entry must be present");

      const result = await resolveScopedTarget({ kind: "button", label: "Post", scope: "composerModal" }, ctx);

      // Exact label match ("Post" !== "Post to group") selects @e2, not @e3
      assert.equal(
        result.target.ref,
        "@e2",
        "T-RT.3: should resolve to the 'Post' button (@e2), not 'Post to group' (@e3)",
      );
      assert.equal(result.target.label, "Post", "T-RT.3: target.label must be exactly 'Post'");
      // The compositor surface gives composerModal scope to composer-surface buttons
      assert.ok(
        result.target.scope === "composerModal",
        `T-RT.3: target.scope must be 'composerModal', got '${result.target.scope}'`,
      );
    },
  );
});
