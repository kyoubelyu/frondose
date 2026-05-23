/**
 * P-Y2.1 Step 5 — T-Token.1..5 (Frondose design-token module) — FILLED.
 *
 * Pure-unit tests: import `src/tauri/ui/frondoseTokens.ts` (DOM-free single source of truth for the
 * OQ-Y2.7 BLEND palette: navy/green/sand) directly and assert its values. Anchor hexes LOCKED at Step 5
 * (operator-confirmed blend): navy #15487B / green #46B54A / sand #D9A75F; auxiliary scale steps are
 * validated as well-formed hex (not hard-pinned — provisional per plan §3 row 1).
 *
 * Gate coverage:
 *   G-PY2.1.1 — token module exists, DOM-free, values match design-doc Appendix A (T-Token.1..5)
 *   G-PY2.1.6 — brand assets present (T-Token.5)
 *
 * Run (mock): node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *   --test-timeout=30000 tests/tauri/frondose-tokens-pY2.1.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACCENT,
  BRAND,
  FONT_MONO,
  FONT_SANS,
  LEAF_SVG,
  LOGO_FULL,
  LOGO_MARK,
  SEMANTIC,
  SURFACE,
  TEXT,
} from "../../src/tauri/ui/frondoseTokens.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "..", "src", "tauri", "ui");
const HEX6 = /^#[0-9A-Fa-f]{6}$/;

describe("frondoseTokens — BLEND palette (OQ-Y2.7 navy/green/sand) (G-PY2.1.1)", () => {
  it("T-Token.1: when reading the BLEND anchor hexes, navy brand + green success + sand accent + surface/text anchors hold", () => {
    // Given: the frondoseTokens module
    // When:  reading BRAND['600'], SEMANTIC.success, ACCENT['500'], SURFACE.deep, SURFACE.bg, TEXT.primary
    // Then:  the operator-confirmed BLEND anchors hold (navy/green/sand + surface/text)
    assert.equal(BRAND["600"], "#15487B", "BRAND['600'] must be navy #15487B");
    assert.equal(SEMANTIC.success, "#46B54A", "SEMANTIC.success must be green #46B54A");
    assert.equal(ACCENT["500"], "#D9A75F", "ACCENT['500'] must be sand #D9A75F");
    assert.equal(SURFACE.deep, "#161A14", "SURFACE.deep must be #161A14 (dark Auto)");
    assert.equal(SURFACE.bg, "#F4F2EB", "SURFACE.bg must be #F4F2EB (light Manual)");
    assert.equal(TEXT.primary, "#2A2A22", "TEXT.primary must be #2A2A22");
    // Edge: every BRAND/ACCENT scale step is a well-formed 6-digit hex (auxiliary steps provisional but valid).
    for (const [k, v] of [...Object.entries(BRAND), ...Object.entries(ACCENT)]) {
      assert.match(v, HEX6, `${k} must be a 6-digit hex; got ${v}`);
    }
  });

  it("T-Token.2: when comparing brand vs success, they are NOT equal (navy brand frees green for success — design-doc L97)", () => {
    // Given: the module
    // When:  comparing BRAND['600'] (navy) and SEMANTIC.success (green)
    // Then:  they differ — the 'brand ≠ success' rule holds because brand is navy, not green
    assert.notEqual(BRAND["600"], SEMANTIC.success, "navy brand must not equal green success");
  });

  it("T-Token.3: when reading the font stacks, FONT_SANS starts with Inter+system-ui and FONT_MONO includes ui-monospace", () => {
    // Given: the module
    // When:  reading FONT_SANS / FONT_MONO
    // Then:  FONT_SANS starts with '"Inter"' and includes 'system-ui'; FONT_MONO includes 'ui-monospace'
    assert.ok(FONT_SANS.startsWith('"Inter"'), `FONT_SANS must start with "Inter"; got ${FONT_SANS}`);
    assert.ok(FONT_SANS.includes("system-ui"), "FONT_SANS must include system-ui");
    assert.ok(FONT_MONO.includes("ui-monospace"), "FONT_MONO must include ui-monospace");
  });

  it("T-Token.4: when reading LEAF_SVG, it is DOM-free data (viewBox 0 0 24 24, ≥3 string paths)", () => {
    // Given: the module
    // When:  reading LEAF_SVG
    // Then:  viewBox==='0 0 24 24' AND paths.length>=3 (stem + ≥2 fronds) AND every path is a string (no DOM node built at import)
    assert.equal(LEAF_SVG.viewBox, "0 0 24 24", "LEAF_SVG.viewBox must be '0 0 24 24'");
    assert.ok(LEAF_SVG.paths.length >= 3, `LEAF_SVG.paths must have >=3 entries; got ${LEAF_SVG.paths.length}`);
    for (const p of LEAF_SVG.paths)
      assert.equal(typeof p, "string", "every LEAF_SVG path must be a string (DOM-free data)");
  });

  it("T-Token.5: when reading the logo-asset paths, they are relative refs and both SVG files exist on disk", () => {
    // Given: the module + src/tauri/ui/
    // When:  reading LOGO_MARK / LOGO_FULL and stat-ing the asset files
    // Then:  relative refs (mark-crop + full lockup) AND both src/tauri/ui/frondose-logo*.svg EXIST (copied from docs/)
    assert.equal(LOGO_MARK, "./frondose-logo-mark.svg", "LOGO_MARK must be the mark-crop relative path");
    assert.equal(LOGO_FULL, "./frondose-logo.svg", "LOGO_FULL must be the full-lockup relative path");
    assert.ok(existsSync(join(UI_DIR, "frondose-logo-mark.svg")), "src/tauri/ui/frondose-logo-mark.svg must exist");
    assert.ok(existsSync(join(UI_DIR, "frondose-logo.svg")), "src/tauri/ui/frondose-logo.svg must exist");
  });
});
