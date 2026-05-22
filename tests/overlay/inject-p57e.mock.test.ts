/**
 * P-57e rev-2 Step 5 — T-SelfHeal.1, T-SelfHeal.2, T-Click.1, T-Click.2 — FILLED
 * (G-P57e.1, G-P57e.2, G-P57e.3, G-P57e.4)
 *
 * Approach chosen at Step 5 (per Step 4a documented ambiguity #2):
 *   - T-SelfHeal.1/2: substring-grep of OVERLAY_BOOTSTRAP_JS for the HOST_STYLE constant +
 *     2nd MutationObserver (attributeFilter:['style']) + equality-check guard + re-assert body.
 *     The self-heal observer callback is inline + IIFE-scoped (not extractable as a standalone
 *     function); behavioral runtime verification happens at T-LIVE.SelfHeal on real Chrome.
 *   - T-Click.1/2: EXTRACT the `getElementRef` function source from OVERLAY_BOOTSTRAP_JS +
 *     eval it via `new Function('document', ...)` with a mock DOM, then call it behaviorally.
 *     getElementRef is a pure DOM-walk function — fully testable in isolation with mock nodes.
 *
 * Per source grep at Step 5 baseline (post-Step 4b):
 *   - inject.ts L17 `var HOST_STYLE = 'all:initial; position:fixed; bottom:72px; right:16px; z-index:2147483647;';`
 *   - L94 `if (host.getAttribute('style') !== HOST_STYLE)` guard
 *   - L95 `host.style.cssText = HOST_STYLE;` re-assert
 *   - L97 `.observe(host, { attributes: true, attributeFilter: ['style'] })`
 *   - L560 `function getElementRef(target)` with `matched` flag + depth=8 walk + selector union
 *   - L615 `if (ref === null) return;` in debouncedClick
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/overlay/inject-p57e.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OVERLAY_BOOTSTRAP_JS } from "../../src/overlay/inject.js";

// ─── getElementRef extraction helper (vm-eval with mock DOM) ────────────────

/** Extract the `function getElementRef(target) { ... }` source from OVERLAY_BOOTSTRAP_JS
 *  by brace-matching from the declaration to its closing brace. */
function extractGetElementRefSource(): string {
  const start = OVERLAY_BOOTSTRAP_JS.indexOf("function getElementRef(target)");
  assert.ok(start >= 0, "getElementRef function must be present in OVERLAY_BOOTSTRAP_JS");
  // Brace-match from the first `{` after the declaration.
  let i = OVERLAY_BOOTSTRAP_JS.indexOf("{", start);
  let depth = 0;
  for (; i < OVERLAY_BOOTSTRAP_JS.length; i++) {
    const ch = OVERLAY_BOOTSTRAP_JS[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return OVERLAY_BOOTSTRAP_JS.slice(start, i + 1);
      }
    }
  }
  throw new Error("getElementRef closing brace not found");
}

/** Build a callable getElementRef bound to a mock `document`. */
// biome-ignore lint/suspicious/noExplicitAny: vm-eval'd function shape is dynamic
function buildGetElementRef(mockDocument: any): (target: unknown) => any {
  const src = extractGetElementRefSource();
  // new Function injects `document` as a parameter; the extracted source declares getElementRef
  // and we return it.
  const factory = new Function("document", `${src}; return getElementRef;`);
  return factory(mockDocument);
}

// ─── Mock DOM element factory ────────────────────────────────────────────────

interface MockEl {
  tagName: string;
  textContent: string;
  parentElement: MockEl | null;
  attrs: Record<string, string>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

function makeEl(tagName: string, attrs: Record<string, string> = {}, textContent = ""): MockEl {
  return {
    tagName,
    textContent,
    parentElement: null,
    attrs,
    getAttribute(name: string) {
      return name in this.attrs ? this.attrs[name] : null;
    },
    hasAttribute(name: string) {
      return name in this.attrs;
    },
  };
}

function chain(...els: MockEl[]): MockEl {
  // els[0] is innermost (the click target); link parentElement chain upward.
  for (let i = 0; i < els.length - 1; i++) {
    els[i].parentElement = els[i + 1];
  }
  return els[0];
}

// ─── T-SelfHeal.1 — self-heal re-asserts HOST_STYLE on style-wipe ───────────

describe("OVERLAY_BOOTSTRAP_JS — MutationObserver host-style self-heal restores HOST_STYLE on wipe (G-P57e.1)", () => {
  it("T-SelfHeal.1: given OVERLAY_BOOTSTRAP_JS with host-style self-heal observer, WHEN substring-grep applied, THEN source contains the HOST_STYLE constant + a 2nd MutationObserver scoped to host with attributeFilter:['style'] + a `host.style.cssText = HOST_STYLE` re-assert body (structural verification; behavioral runtime at T-LIVE.SelfHeal)", () => {
    // HOST_STYLE constant single-source-of-truth
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes(
        "var HOST_STYLE = 'all:initial; position:fixed; bottom:72px; right:16px; z-index:2147483647;'",
      ),
      "must contain HOST_STYLE constant declaration (single source of truth)",
    );
    // initial set references the constant
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("host.style.cssText = HOST_STYLE"),
      "must set host.style.cssText = HOST_STYLE (constant reuse + re-assert body)",
    );
    // 2nd observer scoped to host attributes, filtered to 'style'
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("attributeFilter: ['style']"),
      "must contain a MutationObserver with attributeFilter:['style'] (host-style self-heal)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("attributes: true"),
      "self-heal observer must observe with attributes:true",
    );
  });
});

// ─── T-SelfHeal.2 — CSSOM-property guard prevents infinite loop (D-P57e-01 fix) ─

describe("OVERLAY_BOOTSTRAP_JS — CSSOM-property guard prevents self-heal infinite loop (G-P57e.2)", () => {
  // D-P57e-01 fix (Step 5a): the ORIGINAL guard `host.getAttribute('style') !== HOST_STYLE`
  // was permanently true at runtime — Chrome serializes `all:initial` (in HOST_STYLE) into
  // ~250 longhand `<prop>: initial;` declarations, so the readback never equals the literal
  // HOST_STYLE → re-assert on every observer fire → INFINITE LOOP → page freeze (caught at
  // T-LIVE.SelfHeal Round 1). The fix guards on STABLE single-value CSSOM property reads
  // (host.style.position / host.style.zIndex) instead of the full serialized attribute:
  // after re-assert, position==='fixed' + zIndex==='2147483647' → guard false on the
  // self-triggered re-fire → loop terminates. On a real wipe, position==='' → guard true →
  // heal once.
  it("T-SelfHeal.2: given OVERLAY_BOOTSTRAP_JS self-heal observer (post-D-P57e-01-fix), WHEN substring-grep applied, THEN the observer body contains the CSSOM-property guard `host.style.position !== 'fixed'` (and/or `host.style.zIndex !== '2147483647'`) BEFORE the re-assert — terminating the self-fire loop (the OLD `getAttribute('style') !== HOST_STYLE` guard is GONE; it was permanently-true due to all:initial serialization)", () => {
    // NEW guard present
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("host.style.position !== 'fixed'"),
      "must contain CSSOM-property guard `host.style.position !== 'fixed'` (D-P57e-01 fix)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("host.style.zIndex !== '2147483647'"),
      "must contain `host.style.zIndex !== '2147483647'` second clause of the load-bearing-property guard",
    );
    // OLD broken guard MUST be gone
    assert.ok(
      !OVERLAY_BOOTSTRAP_JS.includes("host.getAttribute('style') !== HOST_STYLE"),
      "OLD guard `host.getAttribute('style') !== HOST_STYLE` must be REMOVED (was permanently-true → infinite loop per D-P57e-01)",
    );
    // Guard precedes the re-assert (guard wraps the cssText set).
    const guardIdx = OVERLAY_BOOTSTRAP_JS.indexOf("host.style.position !== 'fixed'");
    const reassertIdx = OVERLAY_BOOTSTRAP_JS.indexOf("host.style.cssText = HOST_STYLE", guardIdx);
    assert.ok(
      guardIdx >= 0 && reassertIdx > guardIdx,
      "CSSOM-property guard must PRECEDE the re-assert (guard wraps the cssText set)",
    );
  });
});

// ─── T-Click.1 — getElementRef returns enriched ref for interactive ancestor ─

describe("getElementRef (extracted) — returns enriched ref payload for interactive ancestor (G-P57e.3)", () => {
  it("T-Click.1: given DOM <div><button aria-label='Connect' data-control-name='connect_btn'><span>Connect</span></button></div> with click target = span, WHEN getElementRef(span) called, THEN returns {tag:'BUTTON', text:'Connect', ariaLabel:'Connect', controlName:'connect_btn'} (walk-up to BUTTON ancestor + selector union)", () => {
    const documentEl = makeEl("HTML");
    const bodyEl = makeEl("BODY");
    bodyEl.parentElement = documentEl;
    const mockDocument = { documentElement: documentEl, body: bodyEl };

    const button = makeEl("BUTTON", { "aria-label": "Connect", "data-control-name": "connect_btn" }, "Connect");
    const span = makeEl("SPAN", {}, "Connect");
    chain(span, button, bodyEl);

    const getElementRef = buildGetElementRef(mockDocument);
    const ref = getElementRef(span);

    assert.ok(ref !== null, "getElementRef must return a non-null ref for the button ancestor");
    assert.equal(ref.tag, "BUTTON", "ref.tag must be 'BUTTON' (walked up from span)");
    assert.equal(ref.text, "Connect", "ref.text must be 'Connect'");
    assert.equal(ref.ariaLabel, "Connect", "ref.ariaLabel must be 'Connect'");
    assert.equal(ref.controlName, "connect_btn", "ref.controlName must be 'connect_btn'");
  });
});

// ─── T-Click.2 — getElementRef returns null for non-interactive + input/textarea ─

describe("getElementRef (extracted) — returns null for non-interactive + input/textarea (G-P57e.4)", () => {
  it("T-Click.2: given (1) deep non-interactive <div> tree, (2) target = <input>, (3) target inside <textarea>, WHEN getElementRef(target) called for each, THEN all 3 return null (input/textarea bail per OQ-3; non-interactive depth-8 miss → null)", () => {
    const documentEl = makeEl("HTML");
    const bodyEl = makeEl("BODY");
    bodyEl.parentElement = documentEl;
    const mockDocument = { documentElement: documentEl, body: bodyEl };
    const getElementRef = buildGetElementRef(mockDocument);

    // Scenario 1: deep non-interactive div tree (no interactive ancestor within depth=8)
    const d1 = makeEl("DIV", {}, "x");
    const d2 = makeEl("DIV", {}, "x");
    const d3 = makeEl("DIV", {}, "x");
    chain(d1, d2, d3, bodyEl);
    assert.equal(getElementRef(d1), null, "(1) non-interactive div tree → null");

    // Scenario 2: target IS an <input> (OQ-3 bail)
    const input = makeEl("INPUT", {}, "");
    input.parentElement = bodyEl;
    assert.equal(getElementRef(input), null, "(2) input element → null (OQ-3 double-fire avoidance)");

    // Scenario 3: target inside a <textarea> (OQ-3 bail — walk reaches textarea ancestor)
    const ta = makeEl("TEXTAREA", {}, "draft");
    const innerSpan = makeEl("SPAN", {}, "draft");
    chain(innerSpan, ta, bodyEl);
    assert.equal(getElementRef(innerSpan), null, "(3) span inside textarea → null (OQ-3 bail at textarea ancestor)");
  });
});
