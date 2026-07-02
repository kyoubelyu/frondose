/**
 * Phase P-ZH-2 Step 2 — T-Resolve.1..2 (scaffold): the additive `actionKind?` resolver mode.
 *
 * Source-under-test:
 *   src/linkedin/logic/scopeResolver/shared.ts       — ResolveScopedTargetInput (needs `actionKind?`)
 *   src/linkedin/logic/scopeResolver/targetResolution.ts — resolveScopedTarget (needs the
 *     kind-match branch: when actionKind is set and label/ref are absent, match entries by
 *     classifyActionName(entry.name) === actionKind instead of throwing the "requires a target
 *     label or --ref" invalid-input error — plan §5.5).
 *
 * Ground-truthed this session: `resolveScopedTarget({kind:"button", actionKind:"connect_open",
 * scope:"actions"})` (no label, no ref) hits the EXISTING early guard in resolveScopedTarget
 * ("The button command requires a target label or --ref") and throws CommandInvalidInputError
 * TODAY, unconditionally — the actionKind field is not recognized at all yet. Both assertions
 * below are REAL (expect a successful resolution, not a throw) and are the genuine pre-Step-4 RED.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit tests/linkedin/logic/scopeResolver-pZh2.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InspectSummary } from "../../../src/linkedin/logic/contracts/inspect.js";
import { resolveScopedTarget } from "../../../src/linkedin/logic/scopeResolver/targetResolution.js";
import type {
  CurrentSurfaceContext,
  RuntimeVisibleScopeInspection,
  SnapshotEntry,
} from "../../../src/linkedin/logic/surface/currentSurfaceTypes.js";
import { createVisibleScopeFromEntries } from "../../../src/linkedin/logic/surface/visibleScopeCommon.js";

function entry(role: string, name: string, ref: string): SnapshotEntry {
  return { ref, role, name };
}

function scopedContext(opts: {
  pageUrl: string;
  surface: string;
  activeLayer?: "page" | "modal" | "overlay";
  entries?: SnapshotEntry[];
  inspections?: RuntimeVisibleScopeInspection[];
  availableScopes?: { id: string; label: string }[];
}): CurrentSurfaceContext {
  const activeLayer = opts.activeLayer ?? "page";
  const inspections = opts.inspections ?? [];
  const summary: InspectSummary = {
    surface: opts.surface,
    activeLayer,
    availableScopes: opts.availableScopes ?? [],
    visibleScopes: inspections.map((i) => i.scope),
    text: [],
    buttons: [],
    inputs: [],
    interactiveRegions: [],
    ambiguityCases: [],
  };
  return {
    pageUrl: opts.pageUrl,
    surface: opts.surface,
    activeLayer,
    entries: opts.entries ?? [],
    repeatedControls: [],
    visibleScopeInspections: inspections,
    summary,
  };
}

const PROFILE_URL = "https://www.linkedin.com/in/jane-doe/";

describe("T-Resolve.1 — actionKind:'connect_open' resolves EN + ZH entries without a label", () => {
  it("T-Resolve.1: resolveScopedTarget({kind:'button', actionKind:'connect_open', scope:'actions'}) resolves the ZH entry '邀请X加为好友' and the EN entry 'Connect' — no English label required", async () => {
    // Given: a profile "actions" visible scope containing ONLY a ZH connect-open entry (case A),
    //        and separately one containing ONLY the EN "Connect" entry (case B).
    // When:  resolveScopedTarget is called with actionKind:"connect_open" and NO label/ref.
    // Then:  both cases resolve successfully to their respective entry — genuinely RED today
    //        (the call throws CommandInvalidInputError unconditionally; actionKind is unrecognized).
    const zhCtx = scopedContext({
      pageUrl: PROFILE_URL,
      surface: "profile",
      inspections: [
        createVisibleScopeFromEntries("actions", "profileActions", "Profile actions", "profileView", [
          entry("link", "邀请Jaiden Silva加为好友", "@e1"),
        ]),
      ],
    });
    const enCtx = scopedContext({
      pageUrl: PROFILE_URL,
      surface: "profile",
      inspections: [
        createVisibleScopeFromEntries("actions", "profileActions", "Profile actions", "profileView", [
          entry("link", "Connect", "@e1"),
        ]),
      ],
    });

    let zhThrew: unknown = null;
    let zhResolved: Awaited<ReturnType<typeof resolveScopedTarget>> | undefined;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: actionKind is not yet part of ResolveScopedTargetInput — Step 4 adds it
      zhResolved = await resolveScopedTarget({ kind: "button", actionKind: "connect_open", scope: "actions" } as any, zhCtx);
    } catch (e) {
      zhThrew = e;
    }
    assert.equal(zhThrew, null, `expected the ZH actionKind resolve to succeed, but it threw: ${zhThrew}`);
    assert.equal(zhResolved?.target.label, "邀请Jaiden Silva加为好友", "resolved target must be the ZH connect-open entry");

    let enThrew: unknown = null;
    let enResolved: Awaited<ReturnType<typeof resolveScopedTarget>> | undefined;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: actionKind is not yet part of ResolveScopedTargetInput — Step 4 adds it
      enResolved = await resolveScopedTarget({ kind: "button", actionKind: "connect_open", scope: "actions" } as any, enCtx);
    } catch (e) {
      enThrew = e;
    }
    assert.equal(enThrew, null, `expected the EN actionKind resolve to succeed, but it threw: ${enThrew}`);
    assert.equal(enResolved?.target.label, "Connect", "resolved target must be the EN Connect entry");
  });
});

describe("T-Resolve.2 — actionKind:'post_publish' resolves a ZH Post button", () => {
  it("T-Resolve.2: resolveScopedTarget({kind:'button', actionKind:'post_publish', scope:'composerModal'}) resolves a ZH-labeled Post button in the composer modal", async () => {
    // Given: a composer-modal surface with a single ZH publish button ("发布" — plan §5.1's own
    //   POST_PUBLISH_RE sketch guess, UNCONFIRMED pending Step-5 live capture per plan §9).
    // When:  resolveScopedTarget is called with actionKind:"post_publish" and NO label/ref.
    // Then:  resolves to that entry — genuinely RED today (same unconditional invalid-input throw).
    const ctx = scopedContext({
      pageUrl: "https://www.linkedin.com/feed/",
      surface: "composer-modal",
      activeLayer: "modal", // composerModal requires the "modal" active layer (normalize.ts ensureLayerCompatibleWithScope)
      entries: [entry("button", "发布", "@e1")],
      availableScopes: [{ id: "composerModal", label: "Composer modal" }],
    });

    let threw: unknown = null;
    let resolved: Awaited<ReturnType<typeof resolveScopedTarget>> | undefined;
    try {
      resolved = await resolveScopedTarget(
        // biome-ignore lint/suspicious/noExplicitAny: actionKind is not yet part of ResolveScopedTargetInput — Step 4 adds it
        { kind: "button", actionKind: "post_publish", scope: "composerModal" } as any,
        ctx,
      );
    } catch (e) {
      threw = e;
    }
    assert.equal(threw, null, `expected the ZH post_publish actionKind resolve to succeed, but it threw: ${threw}`);
    assert.equal(resolved?.target.label, "发布", "resolved target must be the ZH Post button");
  });
});
