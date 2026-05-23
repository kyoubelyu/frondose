/**
 * P-Y2.2a Step 5 — T-Css.1..7 — FILLED.
 *
 * Pure-unit tests for the shadow-scope CSS transform (plan §6.4-C): `transformCssForShadow` +
 * `OVERLAY_LAYOUT_OVERRIDES` from `src/overlay/cssTransform.ts`. index.html's <style> is the SINGLE CSS
 * source (OQ-Y2.2.3-ii); the gen script feeds it through this transform to produce the shadow-scoped
 * `frondoseCss.generated.ts` with zero design drift.
 *
 * Gate coverage: G-PY2.2a.2 (CSS transform — shadow-scoped, deterministic, no document-level leak).
 *
 * Run (mock): node --import tsx --test --test-force-exit --test-timeout=30000 \
 *   tests/overlay/cssTransform-pY2.2a.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { OVERLAY_LAYOUT_OVERRIDES, transformCssForShadow } from "../../src/overlay/cssTransform.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEX_HTML = join(REPO, "src", "tauri", "ui", "index.html");

/** The real index.html <style> body (the single CSS source the gen script transforms). */
let indexStyle = "";
before(() => {
  const html = readFileSync(INDEX_HTML, "utf8");
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(m?.[1], "index.html must contain a <style> block");
  indexStyle = m[1];
});

describe("transformCssForShadow — :root → :host (G-PY2.2a.2)", () => {
  // Given: transformCssForShadow.  When: passed ":root { --brand-600: #15487B; }".
  // Then: output contains ":host {" and NO ":root".
  it("T-Css.1: when passed ':root { --brand-600: #15487B; }', the output contains ':host {' and no ':root'", () => {
    const out = transformCssForShadow(":root { --brand-600: #15487B; }");
    assert.ok(out.includes(":host {"), "must rescope :root → :host");
    assert.ok(!out.includes(":root"), "no :root may survive into the shadow sheet");
  });
});

describe("transformCssForShadow — body.mode-auto block → :host(.mode-auto) (G-PY2.2a.2)", () => {
  // Given: the fn.  When: passed "body.mode-auto { --page-bg: #161A14; }".
  // Then: output contains ":host(.mode-auto) {" and NO "body.mode-auto {".
  it("T-Css.2: when passed 'body.mode-auto { --page-bg: #161A14; }', output contains ':host(.mode-auto) {' and no 'body.mode-auto {'", () => {
    const out = transformCssForShadow("body.mode-auto { --page-bg: #161A14; }");
    assert.ok(out.includes(":host(.mode-auto) {"), "block form rescoped");
    assert.ok(!out.includes("body.mode-auto {"), "no body.mode-auto block survives");
  });
});

describe("transformCssForShadow — body.mode-auto descendant → :host(.mode-auto) X (G-PY2.2a.2)", () => {
  // Given: the fn.  When: passed "body.mode-auto .seg-tab.active { color: red; }".
  // Then: output contains ":host(.mode-auto) .seg-tab.active".
  it("T-Css.3: when passed 'body.mode-auto .seg-tab.active { color: red; }', output contains ':host(.mode-auto) .seg-tab.active'", () => {
    const out = transformCssForShadow("body.mode-auto .seg-tab.active { color: red; }");
    assert.ok(out.includes(":host(.mode-auto) .seg-tab.active"), "descendant form rescoped");
    assert.ok(!/(^|[},])\s*body\.mode-auto\b/m.test(out), "no body.mode-auto descendant survives");
  });
});

describe("transformCssForShadow — body:not(.mode-auto) descendant → :host(:not(.mode-auto)) X (G-PY2.2a.2)", () => {
  // Given: the fn.  When: passed "body:not(.mode-auto) #auto-stage { display: none; }".
  // Then: output contains ":host(:not(.mode-auto)) #auto-stage".
  it("T-Css.4: when passed 'body:not(.mode-auto) #auto-stage { display: none; }', output contains ':host(:not(.mode-auto)) #auto-stage'", () => {
    const out = transformCssForShadow("body:not(.mode-auto) #auto-stage { display: none; }");
    assert.ok(out.includes(":host(:not(.mode-auto)) #auto-stage"), ":not form rescoped");
    assert.ok(!out.includes("body:not(.mode-auto)"), "no body:not survives");
  });
});

describe("transformCssForShadow — real index.html <style>: no document-level body selector leaks (G-PY2.2a.2)", () => {
  // Given: the fn fed the REAL index.html <style> body.  When: the output is scanned.
  // Then: output contains ":host" AND a body-element selector regex finds 0 matches (no document-level leak).
  it("T-Css.5: when fed the real index.html <style>, output contains ':host' and a body-element selector regex finds 0 matches (no document-level leak)", () => {
    const out = transformCssForShadow(indexStyle);
    assert.ok(out.includes(":host"), "transformed sheet must carry :host");
    const bodyLeak = out.match(/(^|[},])\s*(html\s*,\s*)?body\b/gm) ?? [];
    assert.equal(
      bodyLeak.length,
      0,
      `no document-level body selector may leak into the shadow sheet; found ${JSON.stringify(bodyLeak)}`,
    );
  });
});

describe("transformCssForShadow + OVERLAY_LAYOUT_OVERRIDES — panel overrides appended; .app off 100vh (G-PY2.2a.2)", () => {
  // Given: the full pipeline output (transform + "\n" + OVERLAY_LAYOUT_OVERRIDES).  When: inspected.
  // Then: .app width 320px / :host(.mode-auto) .app 300px + .scroll-area max-height + a height override AFTER
  //       the original .app{…height:100vh…} rule (so the panel is a compact card, not a full-viewport window).
  it("T-Css.6: the full pipeline output contains the .app panel-sizing override (width 320px / auto 300px) + .scroll-area max-height + a height override after the original 100vh .app rule", () => {
    const out = `${transformCssForShadow(indexStyle)}\n${OVERLAY_LAYOUT_OVERRIDES}`;
    assert.match(out, /\.app\s*\{[^}]*width:\s*320px/, ".app override sets width 320px (Manual)");
    assert.match(
      out,
      /:host\(\.mode-auto\)\s*\.app\s*\{[^}]*width:\s*300px/,
      ":host(.mode-auto) .app sets width 300px",
    );
    assert.match(out, /\.scroll-area\s*\{[^}]*max-height:/, ".scroll-area gets a max-height");
    // the original index.html .app uses height:100vh; the override .app rule must come AFTER it (cascade wins).
    const origIdx = out.search(/\.app\s*\{[^}]*height:\s*100vh/);
    const overrideIdx = out.lastIndexOf(
      OVERLAY_LAYOUT_OVERRIDES.match(/\.app\s*\{[^}]*max-height:\s*700px[\s\S]*?\}/)?.[0] ?? ".app { height: auto",
    );
    assert.ok(origIdx >= 0, "the original .app{…height:100vh…} rule must exist in the source sheet");
    assert.ok(
      overrideIdx > origIdx,
      "the panel-sizing override .app rule must appear AFTER the original 100vh rule (overrides win)",
    );
  });
});

describe("transformCssForShadow — deterministic (G-PY2.2a.2)", () => {
  // Given: transformCssForShadow.  When: called twice on the same input.  Then: byte-identical (pure).
  it("T-Css.7: when called twice on the same input, the two outputs are byte-identical (pure)", () => {
    assert.equal(
      transformCssForShadow(indexStyle),
      transformCssForShadow(indexStyle),
      "transform must be pure/deterministic",
    );
    // edge: empty input → empty output (no throw)
    assert.equal(transformCssForShadow(""), "");
  });
});
