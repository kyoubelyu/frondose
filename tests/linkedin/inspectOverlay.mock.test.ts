/**
 * P-59 Layer-2 Step 4a — T-Inspect.1 — SCAFFOLD (D-P59-INSPECT-1)
 *
 * Source-structural tests for the overlay-aware inspect fix:
 *   (H) `src/linkedin/snapshotCapture.ts` — `synthesizeOverlayEntries` function + captureCurrentSurfaceContext injection
 *   (I) `src/cdp/snapshot.ts`             — `getFullAXTree` wrapped in try/catch + retry (RC-2)
 *   (K) `src/cdp/client.ts`               — `mergeRefs` method (REQUIRED for clickability — RC-3)
 *   (L) `src/linkedin/types.ts`            — `activeLayer` widened to `"page" | "overlay"`
 *
 * Problem: the LinkedIn More-menu/Connect dropdown is ABSENT from the AX tree when open
 * (aria-hidden timing race); `inspect` returns identical profile-view entries regardless of
 * whether the dropdown is open → `click {label:"Connect"}` fails (no ref in refMap → throws).
 * Fix: synthesize overlay menuitems from the live DOM (not the AX tree), resolve their real
 * backendNodeIds, register them in client.refMap via `client.mergeRefs()`, and inject them
 * into the inspect snapshot so the agent can `click {label:"Connect"}` when the dropdown is open.
 *
 * All assertions FAIL against the pre-builder source.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * Gate/defect coverage:
 *   D-P59-INSPECT-1 (tool_snapshot_failure — inspect blind to overlay) ↦ T-Inspect.1.*
 *   §6.4(H): synthesizeOverlayEntries + captureCurrentSurfaceContext injection ↦ T-Inspect.1.1/2
 *   §6.4(I): snapshot.ts getFullAXTree try/catch+retry ↦ T-Inspect.1.3
 *   §6.4(K): client.ts mergeRefs method (clickability lynchpin) ↦ T-Inspect.1.4
 *   §6.4(L): types.ts activeLayer "overlay" literal ↦ T-Inspect.1.5
 *
 * §10 level: Source-structural (mock proxy for L1 live gate)
 * §11 class if fail: tool_snapshot_failure → fix in CODE (not prompt)
 *
 * Live gate (Step 5, NOT Step 4a):
 *   T-Inspect.1 L1/L2 live — real opened More-dropdown → inspect returns a clickable "Connect"
 *   with a ref that resolves via refMap → click lands → connect dialog opens.
 *
 * Run (mock — source-structural, no browser/LLM):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/linkedin/inspectOverlay.mock.test.ts
 * ════════════════════════════════════════════════════════════════════════════════════
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SNAPSHOT_CAPTURE_SRC = readFileSync(join(REPO, "src/linkedin/snapshotCapture.ts"), "utf-8");
const SNAPSHOT_SRC = readFileSync(join(REPO, "src/cdp/snapshot.ts"), "utf-8");
const CLIENT_SRC = readFileSync(join(REPO, "src/cdp/client.ts"), "utf-8");
const TYPES_SRC = readFileSync(join(REPO, "src/linkedin/types.ts"), "utf-8");

// ─── T-Inspect.1.1 — snapshotCapture.ts defines synthesizeOverlayEntries ────────────────────────────

describe("T-Inspect.1 — D-P59-INSPECT-1: overlay-aware inspect fix (source-structural)", () => {
  it.skip("T-Inspect.1.1: snapshotCapture.ts must define 'synthesizeOverlayEntries' (§6.4(H) — RC-1 DOM-query overlay synth) — FAILS pre-builder: function does not exist; only synthesizeProfileEntries is present", () => {
    // Given: src/linkedin/snapshotCapture.ts source
    // When:  the source is searched for the synthesizeOverlayEntries function definition
    // Then:  the function is present (async function synthesizeOverlayEntries or equivalent)

    assert.ok(
      SNAPSHOT_CAPTURE_SRC.includes("synthesizeOverlayEntries"),
      "T-Inspect.1.1: snapshotCapture.ts must define 'synthesizeOverlayEntries' (§6.4(H)). " +
        "Pre-builder: only 'synthesizeProfileEntries' exists (L161); no overlay synth. FAILS pre-builder.",
    );
  });

  it.skip("T-Inspect.1.2: snapshotCapture.ts captureCurrentSurfaceContext must call synthesizeOverlayEntries AND call client.mergeRefs with the returned refs — FAILS pre-builder: neither call present", () => {
    // Given: src/linkedin/snapshotCapture.ts source
    // When:  captureCurrentSurfaceContext's return block is inspected
    // Then:  synthesizeOverlayEntries is CALLED (not just defined) + mergeRefs is called with its refs

    // ── Assertion 1: synthesizeOverlayEntries called in the capture context ──────────────────────
    assert.ok(
      SNAPSHOT_CAPTURE_SRC.includes("synthesizeOverlayEntries("),
      "T-Inspect.1.2a: snapshotCapture.ts must CALL synthesizeOverlayEntries() (§6.4(H) injection). " +
        "Pre-builder: function call absent. FAILS pre-builder.",
    );

    // ── Assertion 2: mergeRefs called to register overlay refs in client refMap ──────────────────
    assert.ok(
      SNAPSHOT_CAPTURE_SRC.includes("mergeRefs"),
      "T-Inspect.1.2b: snapshotCapture.ts must call client.mergeRefs(...) to register overlay refs " +
        "(§6.4(H) RC-3 — synthesized entries are visible but UNCLICKABLE unless refMap is populated). " +
        "Pre-builder: mergeRefs call absent. FAILS pre-builder.",
    );

    // ── Assertion 3: activeLayer assignment includes the 'overlay' value ─────────────────────────
    assert.ok(
      SNAPSHOT_CAPTURE_SRC.includes('"overlay"'),
      "T-Inspect.1.2c: snapshotCapture.ts captureCurrentSurfaceContext must assign activeLayer:'overlay' " +
        "when overlay entries are present (§6.4(H) + §6.4(L) — agent signal that the overlay is open). " +
        "Pre-builder: return always has activeLayer:'page' (L141). FAILS pre-builder.",
    );
  });

  it.skip("T-Inspect.1.3: snapshot.ts must wrap getFullAXTree in try/catch with a retry after a settle delay (RC-2) — FAILS pre-builder: L23 is a direct call with no error handling", () => {
    // Given: src/cdp/snapshot.ts source
    // When:  the getFullAXTree call is inspected
    // Then:  it is wrapped in try/catch (RC-2: handles animating/transitioning AX tree throws)
    //        AND a retry after a settle delay (setTimeout) is present

    // ── Assertion 1: try/catch wraps the getFullAXTree call ─────────────────────────────────────
    // We verify the source has BOTH getFullAXTree AND try/catch in the same function body.
    // The pre-builder L23 is a bare `const { nodes } = (await client.Accessibility.getFullAXTree(...))`.
    const getFullAXTreeIdx = SNAPSHOT_SRC.indexOf("getFullAXTree");
    assert.notEqual(getFullAXTreeIdx, -1, "T-Inspect.1.3: snapshot.ts must contain getFullAXTree call");

    // Check for try/catch within 300 chars of getFullAXTree (the sketch puts try on the line above)
    const surrounding = SNAPSHOT_SRC.slice(Math.max(0, getFullAXTreeIdx - 50), getFullAXTreeIdx + 300);
    assert.ok(
      surrounding.includes("try") && surrounding.includes("catch"),
      "T-Inspect.1.3a: getFullAXTree must be wrapped in try/catch (§6.4(I) RC-2). " +
        "Pre-builder: L23 is a bare await call with no error handling. FAILS pre-builder.",
    );

    // ── Assertion 2: retry with a settle delay is present ────────────────────────────────────────
    assert.ok(
      SNAPSHOT_SRC.includes("setTimeout") || SNAPSHOT_SRC.includes("settle"),
      "T-Inspect.1.3b: snapshot.ts must include a retry delay (setTimeout) after the first getFullAXTree throw " +
        "(§6.4(I) RC-2 — settle 100ms before retry). Pre-builder: not present. FAILS pre-builder.",
    );
  });

  it.skip("T-Inspect.1.4: client.ts must define a 'mergeRefs' method (§6.4(K) — clickability lynchpin: synthesized overlay refs MUST be in refMap or clickAt throws) — FAILS pre-builder: mergeRefs method does not exist", () => {
    // Given: src/cdp/client.ts source
    // When:  the client class body is searched for mergeRefs
    // Then:  a mergeRefs method is defined (the §6.4(K) additive method)

    // ── Assertion 1: mergeRefs method present ────────────────────────────────────────────────────
    assert.ok(
      CLIENT_SRC.includes("mergeRefs"),
      "T-Inspect.1.4: client.ts must define 'mergeRefs' (§6.4(K)). " +
        "Pre-builder: method does not exist; Object.assign(this.refMap,...) pattern absent. FAILS pre-builder.",
    );

    // ── Assertion 2: Object.assign(this.refMap, ...) pattern (the implementation body) ────────────
    assert.ok(
      CLIENT_SRC.includes("Object.assign(this.refMap") ||
        CLIENT_SRC.includes("Object.assign(this.refMap,") ||
        (CLIENT_SRC.includes("mergeRefs") && CLIENT_SRC.includes("this.refMap")),
      "T-Inspect.1.4b: client.ts mergeRefs must assign extra refs into this.refMap via Object.assign " +
        "(§6.4(K) sketch). Pre-builder: not present. FAILS pre-builder.",
    );
  });

  it.skip("T-Inspect.1.5: types.ts activeLayer must include 'overlay' (widened from literal 'page' to union 'page'|'overlay') — FAILS pre-builder: L32 is activeLayer:'page' literal; L43 is z.literal('page')", () => {
    // Given: src/linkedin/types.ts source
    // When:  the activeLayer field and its Zod schema are inspected
    // Then:  the type allows "overlay" (union type or z.enum with "overlay" member)

    // ── Assertion 1: activeLayer TypeScript type includes "overlay" ──────────────────────────────
    assert.ok(
      TYPES_SRC.includes('"overlay"') || TYPES_SRC.includes("'overlay'"),
      "T-Inspect.1.5a: types.ts activeLayer must include '\"overlay\"' string literal (§6.4(L) widening). " +
        'Pre-builder: L32 is `activeLayer: "page"` — no overlay. FAILS pre-builder.',
    );

    // ── Assertion 2: Zod schema updated (z.enum or z.union includes "overlay") ──────────────────
    const zodSchemaIdx = TYPES_SRC.indexOf("activeLayer");
    const afterActiveLayer = TYPES_SRC.slice(zodSchemaIdx, zodSchemaIdx + 200);
    assert.ok(
      afterActiveLayer.includes('"overlay"') ||
        afterActiveLayer.includes("'overlay'") ||
        TYPES_SRC.includes('z.enum(["page", "overlay"]') ||
        TYPES_SRC.includes("z.enum(['page', 'overlay']"),
      "T-Inspect.1.5b: types.ts Zod schema for activeLayer must include 'overlay' (§6.4(L) — " +
        'was z.literal(\'page\'); must become z.enum(["page","overlay"]) or z.union). ' +
        "Pre-builder: L43 is `activeLayer: z.literal('page')`. FAILS pre-builder.",
    );
  });
});

// ─── T-Inspect.2 — INSPECT-1 5a companion fix: synthesizeProfileMoreEntry ────────────────────────
/**
 * P-59 Layer-2 Step 5 re-run — T-Inspect.2 — synthesizeProfileMoreEntry (INSPECT-1 5a companion fix)
 *
 * Problem (FAIL-1 from Step-5 Layer-2 first run): LinkedIn profile page has TWO buttons labeled
 * "More" in the AX tree. The AX sequential counter places NAV BAR More first (~@e28). The agent
 * clicks @e28 (NAV BAR More) → overlay synth finds 0 menuitems → connect flow dead-ends.
 *
 * Fix: `synthesizeProfileMoreEntry` in snapshotCapture.ts synthesizes a DISTINCT `@pm1` entry
 * ("More actions for <name>") that resolves to the PROFILE-level More button (NOT the nav More),
 * anchored to the h1 element via `compareDocumentPosition`. The entry is unshift'd (prepended)
 * into inspect entries and its backendNodeId is registered via `client.mergeRefs()`.
 *
 * Gate coverage: INSPECT-1 5a companion fix — `tool_snapshot_failure` companion closed.
 * §10 level: Source-structural (GREEN against built code = companion fix landed correctly).
 * §11 class if fail: tool_snapshot_failure → fix in CODE.
 *
 * Run:
 *   node --import tsx --test tests/linkedin/inspectOverlay.mock.test.ts
 */
describe("T-Inspect.2 — INSPECT-1 5a: synthesizeProfileMoreEntry companion fix (source-structural)", () => {
  it("T-Inspect.2.1: snapshotCapture.ts must define 'synthesizeProfileMoreEntry' function", () => {
    // Given: src/linkedin/snapshotCapture.ts source (post-5a builder fix)
    // When:  the source is searched for synthesizeProfileMoreEntry
    // Then:  the function is defined (async function synthesizeProfileMoreEntry)
    assert.ok(
      SNAPSHOT_CAPTURE_SRC.includes("synthesizeProfileMoreEntry"),
      "T-Inspect.2.1: snapshotCapture.ts must define 'synthesizeProfileMoreEntry' — the INSPECT-1 5a " +
        "companion fix that synthesizes a distinct PROFILE More entry (@pm1) unambiguous from nav More.",
    );
  });

  it("T-Inspect.2.2: PROFILE_MORE_SYNTH_JS constant must be defined with data-mai-pm marker and NAV exclusion", () => {
    // Given: src/linkedin/snapshotCapture.ts source
    // When:  PROFILE_MORE_SYNTH_JS is inspected
    // Then:  it contains the data-mai-pm attribute marker + NAV_SELECTOR exclusion (not inside nav/banner)
    assert.ok(
      SNAPSHOT_CAPTURE_SRC.includes("PROFILE_MORE_SYNTH_JS"),
      "T-Inspect.2.2a: PROFILE_MORE_SYNTH_JS constant must be defined.",
    );
    assert.ok(
      SNAPSHOT_CAPTURE_SRC.includes("data-mai-pm"),
      "T-Inspect.2.2b: PROFILE_MORE_SYNTH_JS must mark the picked element with data-mai-pm (DOM marker " +
        "pattern — same as synthesizeOverlayEntries data-mai-ov) so querySelectorAll can resolve it.",
    );
    // NAV exclusion: the script must filter out elements inside nav/banner/header roles
    assert.ok(
      SNAPSHOT_CAPTURE_SRC.includes("role='navigation']") ||
        SNAPSHOT_CAPTURE_SRC.includes('role="navigation"]') ||
        SNAPSHOT_CAPTURE_SRC.includes("closest(NAV") ||
        SNAPSHOT_CAPTURE_SRC.includes("closest(NAV_SELECTOR") ||
        SNAPSHOT_CAPTURE_SRC.includes("role='banner']"),
      "T-Inspect.2.2c: PROFILE_MORE_SYNTH_JS must exclude buttons inside nav/banner/header (NAV selector). " +
        "Without this exclusion, the nav bar More is eligible and may be selected.",
    );
  });

  it("T-Inspect.2.3: captureCurrentSurfaceContext must call synthesizeProfileMoreEntry on the profile surface AND unshift its entries AND call mergeRefs", () => {
    // Given: src/linkedin/snapshotCapture.ts source
    // When:  captureCurrentSurfaceContext profile branch is inspected
    // Then:  synthesizeProfileMoreEntry is called; its entries are unshift'd (prepended); mergeRefs called
    assert.ok(
      SNAPSHOT_CAPTURE_SRC.includes("synthesizeProfileMoreEntry("),
      "T-Inspect.2.3a: captureCurrentSurfaceContext must CALL synthesizeProfileMoreEntry() on profile surface.",
    );
    // unshift: profile More must be prepended so it leads the entry list (survives MAX truncation)
    assert.ok(
      SNAPSHOT_CAPTURE_SRC.includes("unshift") && SNAPSHOT_CAPTURE_SRC.includes("synthesizeProfileMoreEntry"),
      "T-Inspect.2.3b: profile More entries must be unshift'd (prepended) into the entries array — " +
        "so @pm1 appears before AX-tree entries in inspect output and survives MAX_BUTTONS truncation.",
    );
  });

  it("T-Inspect.2.4: synthesizeProfileMoreEntry must return role:'button', name 'More actions for ...' format, and ref '@pm1'", () => {
    // Given: src/linkedin/snapshotCapture.ts source
    // When:  synthesizeProfileMoreEntry return value is inspected
    // Then:  role is "button", name uses "More actions for" prefix, ref key is "pm1" (→ @pm1)
    assert.ok(
      SNAPSHOT_CAPTURE_SRC.includes('"button"') && SNAPSHOT_CAPTURE_SRC.includes("synthesizeProfileMoreEntry"),
      "T-Inspect.2.4a: synthesizeProfileMoreEntry must return role:'button' (clickable entry, not text).",
    );
    assert.ok(
      SNAPSHOT_CAPTURE_SRC.includes("More actions for"),
      "T-Inspect.2.4b: synthesizeProfileMoreEntry label must use 'More actions for <name>' format — " +
        "this is the DISTINCT label that lets the agent pick @pm1 instead of AX-tree 'More' buttons.",
    );
    assert.ok(
      SNAPSHOT_CAPTURE_SRC.includes('"pm1"') || SNAPSHOT_CAPTURE_SRC.includes("pm1"),
      "T-Inspect.2.4c: synthesizeProfileMoreEntry ref key must be 'pm1' (→ @pm1 after @ prefix). " +
        "mergeRefs({pm1: ...}) registers it so clickAt('@pm1') resolves without throwing.",
    );
  });

  it("T-Inspect.2.5: synthesizeProfileMoreEntry must register the ref via client.mergeRefs (clickability lynchpin)", () => {
    // Given: src/linkedin/snapshotCapture.ts source
    // When:  the call site in captureCurrentSurfaceContext is inspected
    // Then:  client.mergeRefs(pm.refs) is called (same lynchpin as synthesizeOverlayEntries)
    // Note:  mergeRefs already present from T-Inspect.1.4 (synthesizeOverlayEntries path)
    //        — this test pins that the PROFILE More path ALSO calls it.
    const pmCallIdx = SNAPSHOT_CAPTURE_SRC.indexOf("synthesizeProfileMoreEntry(");
    assert.notEqual(pmCallIdx, -1, "synthesizeProfileMoreEntry call site must exist");
    // Look for mergeRefs call within 200 chars of the pm call (the if-block surrounds both)
    const pmBlock = SNAPSHOT_CAPTURE_SRC.slice(pmCallIdx, pmCallIdx + 300);
    assert.ok(
      pmBlock.includes("mergeRefs"),
      "T-Inspect.2.5: client.mergeRefs must be called with the profile More refs — same pattern as overlay. " +
        "Without this, clickAt('@pm1') throws 'ref @pm1 not found in current snapshot'.",
    );
  });
});
