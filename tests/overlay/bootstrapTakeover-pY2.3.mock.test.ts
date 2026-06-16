/**
 * P-Y2.3 Step 4a — T-Overlay.1..3 + T-Css.1..2 + T-Drive.1 — SCAFFOLD (assertion bodies = TODO; RED).
 *
 * Source-structural assertions on the assembled `OVERLAY_BOOTSTRAP_JS` (the takeover fragment) + the
 * generated `FRONDOSE_CSS` (the takeover keyframes/classes) + the tool-drive best-effort wrap in click/type.
 *
 * ★ T-Drive.1 is the highest-value safety mock: the cursor/highlight visual is wrapped so a getBox/overlay
 * failure can NEVER block the click/type (a cosmetic visual must not break the agent's core action).
 *
 * LOAD: LOADS NOW. inject.ts (`OVERLAY_BOOTSTRAP_JS`), frondoseCss.generated.ts (`FRONDOSE_CSS`),
 * cssTransform.ts, and click.ts/type.ts source all EXIST. At Step 4a the takeover content is absent (pre-4b),
 * so the bodies are `assert.fail("TODO Step 5: …")`. `OVERLAY_TAKEOVER_CSS` (new export) is read via a NAMESPACE
 * import (undefined until 4b). After 4b the assembled bootstrap + regenerated CSS carry the takeover.
 *
 * Gate coverage: G-PY2.3.6 (overlay layer), .7 (CSS), .4 (tool drive best-effort), .9 (TT-safe).
 *
 * Run (mock): node --import tsx --test --test-force-exit --test-timeout=30000 \
 *   tests/overlay/bootstrapTakeover-pY2.3.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  OVERLAY_LAYOUT_OVERRIDES,
  OVERLAY_TAKEOVER_CSS,
  transformCssForShadow,
} from "../../src/overlay/cssTransform.js";
import { FRONDOSE_CSS } from "../../src/overlay/frondoseCss.generated.js";
import * as inject from "../../src/overlay/inject.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BOOTSTRAP = (inject as { OVERLAY_BOOTSTRAP_JS?: string }).OVERLAY_BOOTSTRAP_JS ?? "";
const CLICK_TS = readFileSync(join(REPO, "src", "tools", "browser", "click.ts"), "utf8");
const TYPE_TS = readFileSync(join(REPO, "src", "tools", "browser", "type.ts"), "utf8");

/** Slice a `window.<fnName> = function(...) { … }` body from the assembled bootstrap (brace-matched). */
function sliceFnBody(src: string, fnName: string): string {
  const start = src.indexOf(`window.${fnName}`);
  assert.ok(start >= 0, `bootstrap must define window.${fnName}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces slicing ${fnName}`);
}

describe("OVERLAY_BOOTSTRAP_JS — the 4 takeover fns + the layer (G-PY2.3.6)", () => {
  // Then: defines __frondoseShowEdgeRing/__frondoseHideEdgeRing/__frondoseShowAgentTarget/__frondoseClearAgentTarget AND builds a
  //       'takeover-layer' appended to shadow, with takeover-ring/takeover-label/agent-cursor/agent-highlight children.
  it("T-Overlay.1: OVERLAY_BOOTSTRAP_JS defines the 4 takeover window fns + builds the takeover-layer (ring/label/cursor/highlight)", () => {
    for (const fn of [
      "window.__frondoseShowEdgeRing",
      "window.__frondoseHideEdgeRing",
      "window.__frondoseShowAgentTarget",
      "window.__frondoseClearAgentTarget",
    ]) {
      assert.ok(BOOTSTRAP.includes(fn), `bootstrap defines ${fn}`);
    }
    for (const cls of ["takeover-layer", "takeover-ring", "takeover-label", "agent-cursor", "agent-highlight"]) {
      assert.ok(BOOTSTRAP.includes(cls), `bootstrap references the ${cls} class`);
    }
    // the layer is appended into the shadow host
    assert.match(BOOTSTRAP, /shadow\.appendChild\(/, "the takeover layer is appended to the shadow root");
  });
});

describe("OVERLAY_BOOTSTRAP_JS — __frondoseShowAgentTarget positions from the box (G-PY2.3.6)", () => {
  // Then: __frondoseShowAgentTarget JSON.parses the payload, reads data.box, sets highlight left/top/width/height
  //       from box.x/y/w/h (per-property .style, NOT cssText), classList.remove('hidden') highlight + cursor.
  it("T-Overlay.2: __frondoseShowAgentTarget reads data.box + sets highlight .style.left/top/width/height per-property (not cssText) + reveals highlight & cursor", () => {
    const body = sliceFnBody(BOOTSTRAP, "__frondoseShowAgentTarget");
    assert.match(body, /JSON\.parse\(/, "parses the payload JSON");
    assert.match(body, /data\.box|\.box/, "reads data.box");
    for (const prop of [".style.left", ".style.top", ".style.width", ".style.height"]) {
      assert.ok(body.includes(prop), `sets highlight ${prop} per-property`);
    }
    assert.match(body, /classList\.remove\(['"]hidden['"]\)/, "reveals via classList.remove('hidden')");
    // per-property mutation (not a cssText blob) — keeps TT/CSP-safe + avoids reflow churn
    assert.ok(!body.includes(".cssText"), "must NOT use .cssText (per-property style only)");
  });
});

describe("OVERLAY_BOOTSTRAP_JS — TT-safe (G-PY2.3.6, .9)", () => {
  it("T-Overlay.3: OVERLAY_BOOTSTRAP_JS contains 0 innerHTML / insertAdjacentHTML / outerHTML", () => {
    for (const sink of ["innerHTML", "insertAdjacentHTML", "outerHTML"]) {
      assert.ok(!BOOTSTRAP.includes(sink), `bootstrap is TrustedTypes-safe — no ${sink}`);
    }
  });
});

describe("FRONDOSE_CSS — takeover CSS shipped in the shadow sheet (G-PY2.3.7)", () => {
  // Then: contains @keyframes borderFlow/targetPulse/pulseDot + .takeover-layer/.takeover-ring/.takeover-label/
  //       .agent-cursor/.agent-highlight; .takeover-layer carries position:fixed, inset:0, pointer-events:none.
  it("T-Css.1: FRONDOSE_CSS contains the 3 @keyframes (borderFlow/targetPulse/pulseDot) + the 5 takeover classes; .takeover-layer is position:fixed inset:0 pointer-events:none", () => {
    for (const kf of ["@keyframes borderFlow", "@keyframes targetPulse", "@keyframes pulseDot"]) {
      assert.ok(FRONDOSE_CSS.includes(kf), `CSS ships ${kf}`);
    }
    for (const cls of [".takeover-layer", ".takeover-ring", ".takeover-label", ".agent-cursor", ".agent-highlight"]) {
      assert.ok(FRONDOSE_CSS.includes(cls), `CSS ships ${cls}`);
    }
    // .takeover-layer must be a full-viewport click-through overlay (property order tolerant)
    assert.match(
      FRONDOSE_CSS,
      /\.takeover-layer\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0[^}]*pointer-events:\s*none/,
      ".takeover-layer is position:fixed inset:0 pointer-events:none",
    );
  });
});

describe("takeover CSS — deterministic regen (G-PY2.3.7)", () => {
  // Then: transformCssForShadow(index)+OVERLAY_LAYOUT_OVERRIDES+OVERLAY_TAKEOVER_CSS run twice = byte-identical,
  //       AND the committed FRONDOSE_CSS matches a fresh run (F-Y4-1 stale-artifact guard).
  it("T-Css.2: the gen pipeline (transform + overrides + takeover) is deterministic AND the committed FRONDOSE_CSS matches a fresh run", () => {
    // Mirror scripts/gen-overlay-assets.ts genCss() exactly.
    const html = readFileSync(join(REPO, "src", "tauri", "ui", "index.html"), "utf8");
    const m = html.match(/<style>([\s\S]*?)<\/style>/);
    assert.ok(m?.[1] !== undefined, "index.html must have a <style> block");
    const style = m?.[1] ?? "";
    const fresh = `${transformCssForShadow(style)}\n${OVERLAY_LAYOUT_OVERRIDES}\n${OVERLAY_TAKEOVER_CSS}`;
    const rerun = `${transformCssForShadow(style)}\n${OVERLAY_LAYOUT_OVERRIDES}\n${OVERLAY_TAKEOVER_CSS}`;
    assert.equal(fresh, rerun, "the gen pipeline is deterministic (byte-identical across runs)");
    // F-Y4-1 stale-artifact guard: the committed generated module must equal a fresh build.
    assert.equal(FRONDOSE_CSS, fresh, "committed FRONDOSE_CSS is up to date — re-run npm run build:overlay-assets");
  });
});

describe("click.ts / type.ts — visual drive is best-effort (NEVER blocks the click) (G-PY2.3.4)", () => {
  // ★ THE LOAD-BEARING SAFETY. Then: each, after resolving target + BEFORE the inputMode branch, calls
  //   client.getBox(target) + session.showAgentTarget?.(box, …) inside a try { … } catch {} (visual-only; the
  //   click/type dispatch is OUTSIDE the try, unaffected by a visual failure).
  it("T-Drive.1: click.ts + type.ts wrap getBox + showAgentTarget?.(...) in try/catch (visual-only; the click/type dispatch is OUTSIDE the try) — a visual failure NEVER blocks the action", () => {
    for (const [name, src] of [
      ["click.ts", CLICK_TS],
      ["type.ts", TYPE_TS],
    ] as const) {
      assert.ok(src.includes("client.getBox("), `${name}: drives client.getBox(target)`);
      assert.match(src, /showAgentTarget\?\./, `${name}: optional-chains showAgentTarget?. (best-effort)`);
      const idxGetBox = src.indexOf("client.getBox(");
      const idxShow = src.indexOf("showAgentTarget?.", idxGetBox);
      const idxVisualCatch = src.indexOf("} catch", idxGetBox); // closes the visual-only try
      const idxDispatch = src.indexOf('inputMode === "hardware"', idxVisualCatch); // the action branch
      assert.ok(idxShow > idxGetBox, `${name}: showAgentTarget?. follows getBox inside the visual block`);
      assert.ok(idxVisualCatch > idxShow, `${name}: the visual try/catch closes after getBox + showAgentTarget`);
      assert.ok(
        idxDispatch > idxVisualCatch,
        `${name}: the input dispatch is OUTSIDE the visual try — a visual/getBox failure NEVER blocks the action`,
      );
    }
  });
});
