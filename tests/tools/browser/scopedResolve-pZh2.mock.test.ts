/**
 * Phase P-ZH-2 Step 2 — T-Slice4.1 (scaffold): the Slice-4 advice path stays locale-consistent.
 *
 * Source-under-test: src/tools/browser/scopedResolve.ts — buildScopedClickAdvice(context, target)
 * → src/linkedin/logic/outwardAction.ts classifyClickDescriptor (plan §7, Class A site A7).
 * classifyClickDescriptor currently recognizes ONLY English-labeled targets (parseDynamicLabel's
 * `/^Invite\s+(.+?)\s+to connect$/i` etc.) — once it calls the new central classifyActionName
 * (Step 4), a ZH connect target should classify identically to its EN counterpart, with NO
 * Slice-4-specific fork.
 *
 * Ground-truthed this session (node --import tsx -e probe, see docs/phase-zh2-test.md):
 *   buildScopedClickAdvice(ctx, zhConnectTarget) → []  (classifyClickDescriptor returns
 *     {isOutbound:false} for the ZH label — none of the English regexes match)
 *   buildScopedClickAdvice(ctx, enConnectTarget) → [identity_missing, memory_recommended]
 * The two outputs DIFFER today — the genuine pre-Step-4 RED this test pins.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit tests/tools/browser/scopedResolve-pZh2.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildScopedClickAdvice } from "../../../src/tools/browser/scopedResolve.js";

// biome-ignore lint/suspicious/noExplicitAny: minimal logic-layer CurrentSurfaceContext fixture
function makeLogicCtx(): any {
  return {
    pageUrl: "https://www.linkedin.com/in/jane-doe/",
    surface: "profile",
    activeLayer: "page",
    entries: [],
    summary: { surface: "profile", activeLayer: "page", availableScopes: [], text: [], buttons: [], inputs: [] },
  };
}

describe("T-Slice4.1 — buildScopedClickAdvice is locale-consistent on a connect target", () => {
  it("T-Slice4.1: buildScopedClickAdvice on a ZH connect target ('邀请X加为好友') yields the SAME (non-empty, isOutbound) advice shape as the EN target ('Invite X to connect')", () => {
    // Given: a ZH connect-open target and its EN equivalent, both on the same profile context.
    // When:  buildScopedClickAdvice(ctx, target) runs for each.
    // Then:  BOTH must produce a non-empty advice array containing an "identity_missing" entry for
    //   the "connect" interaction — proving the Slice-4 advice path is locale-aware through the
    //   shared classifier, not a fork. Currently the ZH call returns [] while the EN call does not
    //   (classifyClickDescriptor is English-only) — the genuine pre-Step-4 RED.
    const ctx = makeLogicCtx();
    const zhTarget = {
      kind: "button",
      selector: "@e1",
      ref: "@e1",
      label: "邀请Jaiden Silva加为好友",
      role: "link",
      scope: "actions",
    };
    const enTarget = {
      kind: "button",
      selector: "@e1",
      ref: "@e1",
      label: "Invite Jane Doe to connect",
      role: "link",
      scope: "actions",
    };

    const zhAdvice = buildScopedClickAdvice(ctx, zhTarget);
    const enAdvice = buildScopedClickAdvice(ctx, enTarget);

    assert.ok(Array.isArray(enAdvice) && enAdvice.length > 0, "sanity: the EN target must already produce advice");
    assert.ok(Array.isArray(zhAdvice) && zhAdvice.length > 0, "the ZH target must ALSO produce non-empty advice (currently returns [])");
    assert.ok(
      // biome-ignore lint/suspicious/noExplicitAny: advice entries are OutwardActionAdvice
      zhAdvice.some((a: any) => a.kind === "identity_missing" && a.interaction === "connect"),
      "the ZH target's advice must include an identity_missing entry for the 'connect' interaction, same as the EN target",
    );
  });
});
