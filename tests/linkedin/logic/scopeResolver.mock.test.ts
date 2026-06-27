import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActiveLayer, InspectSummary } from "../../../src/linkedin/logic/contracts/inspect.js";
import { createForegroundContext } from "../../../src/linkedin/logic/surface/foregroundContext.js";
import { buildCurrentSurfaceSummaryAssembly } from "../../../src/linkedin/logic/surface/currentSurfaceSummary.js";
import type {
  CurrentSurfaceContext,
  SnapshotEntry,
} from "../../../src/linkedin/logic/surface/currentSurfaceTypes.js";
import {
  entryMatchesScope,
  inferScopeForEntry,
  matchesLabel,
} from "../../../src/linkedin/logic/scopeResolver/entryMatching.js";
import { resolveScopedTarget } from "../../../src/linkedin/logic/scopeResolver/targetResolution.js";
import { ScopedTargetResolutionError } from "../../../src/linkedin/logic/scopeResolver/shared.js";

function entry(role: string, name: string, ref: string): SnapshotEntry {
  return { ref, role, name };
}

function composerContext(activeLayer?: ActiveLayer): CurrentSurfaceContext {
  const pageUrl = "https://www.linkedin.com/feed/";
  const entries = [
    entry("textbox", "Text editor for creating content", "@e1"),
    entry("button", "Add media", "@e2"),
    entry("button", "Post", "@e3"),
  ];
  const foregroundContext = createForegroundContext(pageUrl, entries);
  const summaryParts = buildCurrentSurfaceSummaryAssembly(foregroundContext, entries, entries, pageUrl);
  const resolvedActiveLayer = activeLayer ?? foregroundContext.activeLayer;
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

describe("scope resolver entry matching", () => {
  it("T-ScopeResolver.Entry.1: exact label matching is case-insensitive and rejects different labels", () => {
    // Given: a visible Post button entry.
    // When: matchesLabel compares exact and different labels.
    // Then: exact case-insensitive matches pass and unrelated labels fail.
    const postButton = entry("button", "Post", "@e3");

    assert.equal(matchesLabel(postButton, "post"), true);
    assert.equal(matchesLabel(postButton, "Publish"), false);
  });

  it("T-ScopeResolver.Entry.2: composer entries match composer scopes and reject unrelated scopes", () => {
    // Given: a composer modal context containing an input and Post button.
    // When: entryMatchesScope and inferScopeForEntry classify those entries.
    // Then: controls resolve to composer scopes and do not bleed into thread scopes.
    const context = composerContext();
    const input = context.entries[0]!;
    const postButton = context.entries[2]!;

    assert.equal(entryMatchesScope(context, "composerInput", input), true);
    assert.equal(inferScopeForEntry(context, input, "input"), "composerInput");
    assert.equal(entryMatchesScope(context, "composerModal", postButton), true);
    assert.equal(inferScopeForEntry(context, postButton, "button"), "composerModal");
    assert.equal(entryMatchesScope(context, "threadInput", postButton), false);
  });
});

describe("scope resolver target resolution", () => {
  it("T-ScopeResolver.Resolve.1: resolves a scoped composer Post button to its SnapshotEntry ref", async () => {
    // Given: a modal composer context with an accessible Post button.
    // When: resolveScopedTarget targets {kind:'button', label:'Post', scope:'composerModal'}.
    // Then: it returns the Post button ref and public composerModal scope.
    const result = await resolveScopedTarget(
      { kind: "button", label: "Post", scope: "composerModal" },
      composerContext(),
    );

    assert.equal(result.target.selector, "@e3");
    assert.equal(result.target.ref, "@e3");
    assert.equal(result.target.label, "Post");
    assert.equal(result.target.role, "button");
    assert.equal(result.target.scope, "composerModal");
    assert.equal(result.target.preferDirect, true);
  });

  it("T-ScopeResolver.Resolve.2: rejects composer modal resolution when the active layer is not modal", async () => {
    // Given: a context whose scopes claim composerModal but whose active layer is page.
    // When: resolveScopedTarget targets the composer modal Post button.
    // Then: it fails before returning a page-layer target.
    await assert.rejects(
      resolveScopedTarget({ kind: "button", label: "Post", scope: "composerModal" }, composerContext("page")),
      (error: unknown) => {
        assert.ok(error instanceof ScopedTargetResolutionError);
        assert.equal(error.kind, "not_found");
        assert.match(error.message, /active layer.*modal/i);
        return true;
      },
    );
  });
});
