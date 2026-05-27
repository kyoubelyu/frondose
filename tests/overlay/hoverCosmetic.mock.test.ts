/**
 * P-Y2-MA Step 5 — T-PY2MA.Hover.1..3 — assertion bodies filled.
 *
 * Hover overlay cosmetic gaps (G3 sparkles, G5/G7 drag-grip, G9 label).
 *
 * Testing strategy:
 *   Source-structural assertions on bootstrapShell.ts confirm:
 *     T-PY2MA.Hover.1 — sparkles SVG path attribute in __maiBeginAgent (G3)
 *     T-PY2MA.Hover.2 — drag-grip DOM structure (3×2 dots) in buildPanelSkeleton (G7 visual-only)
 *     T-PY2MA.Hover.3 — handoff-button label "Run on Auto" (G9; desktop keeps "Hand off to Auto")
 *
 * Gate coverage:
 *   G-PY2MA.8  — T-PY2MA.Hover.1  (sparkles SVG in agent avatar)
 *   G-PY2MA.9  — T-PY2MA.Hover.2  (drag-grip dot grid)
 *   G-PY2MA.10 — T-PY2MA.Hover.3  (handoff button label)
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/overlay/hoverCosmetic.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { OVERLAY_LAYOUT_OVERRIDES } from "../../src/overlay/cssTransform.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SHELL_TS = readFileSync(join(REPO, "src/overlay/bootstrapShell.ts"), "utf-8");
const INDEX_HTML = readFileSync(join(REPO, "src/tauri/ui/index.html"), "utf-8");

// ─── T-PY2MA.Hover.1 ────────────────────────────────────────────────────────

describe("T-PY2MA.Hover.1 — overlay agent avatar contains sparkles SVG (G-PY2MA.8 / G3)", () => {
  it("T-PY2MA.Hover.1: bootstrapShell.ts __maiBeginAgent creates an SVG with the sparkles path (M12 2.5...)", () => {
    // Given: src/overlay/bootstrapShell.ts source post-builder (Sketch C §5.3.5 pasted)
    // When:  scanned for the sparkles SVG path data inside the __maiBeginAgent definition
    // Then:  the string 'M12 2.5' appears inside bootstrapShell.ts (the sparkles glyph d-attribute)
    const hasSparkles = SHELL_TS.includes("M12 2.5");
    assert.ok(
      hasSparkles,
      "bootstrapShell.ts __maiBeginAgent must create an SVG <path d='M12 2.5...'> (sparkles glyph, G3). " +
        "String 'M12 2.5' absent — FAILS pre-builder (Sketch C §5.3.5 not yet pasted).",
    );
  });

  it("T-PY2MA.Hover.1b: the sparkles path is the SAME glyph as the desktop index.html reference (cross-surface parity)", () => {
    // Given: src/overlay/bootstrapShell.ts + src/tauri/ui/index.html sources
    // When:  both are scanned for the sparkles path data 'M12 2.5'
    // Then:  the same path string appears in both files (consistent avatar across surfaces)
    const shellHasSparkles = SHELL_TS.includes("M12 2.5");
    const htmlHasSparkles = INDEX_HTML.includes("M12 2.5");
    assert.ok(
      shellHasSparkles,
      "bootstrapShell.ts must contain 'M12 2.5' sparkles path (G3 overlay avatar — overlay side).",
    );
    assert.ok(
      htmlHasSparkles,
      "src/tauri/ui/index.html must contain 'M12 2.5' sparkles path (G3 cross-surface parity with overlay). " +
        "Verified in footer dock avatar (.dmsg-avatar svg path). " +
        "If this fails, desktop and overlay have diverged sparkles glyphs.",
    );
  });
});

// ─── T-PY2MA.Hover.2 ────────────────────────────────────────────────────────

describe("T-PY2MA.Hover.2 — overlay topbar has drag-grip with 3 rows × 2 dots (G-PY2MA.9 / G7 visual-only)", () => {
  it("T-PY2MA.Hover.2a: bootstrapShell.ts buildPanelSkeleton creates a .drag-grip element with 3 .drag-grip-row children", () => {
    // Given: src/overlay/bootstrapShell.ts source post-builder (Sketch C §5.3.2 pasted)
    // When:  scanned for 'drag-grip' class creation and the 3-row loop (for gi = 0; gi < 3)
    // Then:  the pattern 'drag-grip' and 'drag-grip-row' and 'drag-grip-dot' all appear
    const hasDragGrip = SHELL_TS.includes("drag-grip");
    const hasDragGripRow = SHELL_TS.includes("drag-grip-row");
    const hasDragGripDot = SHELL_TS.includes("drag-grip-dot");
    assert.ok(
      hasDragGrip && hasDragGripRow && hasDragGripDot,
      "bootstrapShell.ts buildPanelSkeleton topbar must include .drag-grip + .drag-grip-row + .drag-grip-dot " +
        `(G7 visual-only, OQ-6). Found: drag-grip=${hasDragGrip}, drag-grip-row=${hasDragGripRow}, ` +
        `drag-grip-dot=${hasDragGripDot}.`,
    );
  });

  it("T-PY2MA.Hover.2b: the drag-grip loop iterates 3 times with 2 drag-grip-dot appends per row (→ 6 dots total, 3×2 per mockup)", () => {
    // Given: src/overlay/bootstrapShell.ts source post-builder
    // When:  scanned for the 3-iteration loop (gi < 3) and the 2-dot-per-row pattern
    // Then:  'gi < 3' is present (3 rows) and exactly 2 'drag-grip-dot' string occurrences exist
    //        in the source (each occurrence is executed 3 times → 3×2=6 dots total)
    //        OQ-6: NO mousedown listener asserted (visual only)
    const hasThreeIterLoop = SHELL_TS.includes("gi < 3");
    // Count occurrences of 'drag-grip-dot' in the source (each loop iteration has 2 appends)
    const dotMatches = (SHELL_TS.match(/drag-grip-dot/g) ?? []).length;
    assert.ok(
      hasThreeIterLoop,
      "buildPanelSkeleton must have a 3-iteration loop 'gi < 3' (3 rows of drag-grip dots, G7).",
    );
    assert.ok(
      dotMatches >= 2,
      `buildPanelSkeleton loop body must create ≥2 'drag-grip-dot' elements per row ` +
        `(found ${dotMatches} occurrences in source; 3 rows × 2 = 6 dots total, G7).`,
    );
    // Confirm no mousedown listener on the grip (visual-only per OQ-6)
    const gripIdx = SHELL_TS.indexOf("drag-grip");
    const gripSection = SHELL_TS.slice(gripIdx, gripIdx + 400);
    assert.equal(
      gripSection.includes("mousedown"),
      false,
      "drag-grip must NOT have a mousedown listener (OQ-6: visual-only, no drag behavior).",
    );
  });

  it("T-PY2MA.Hover.2c: cssTransform.ts OVERLAY_LAYOUT_OVERRIDES contains .drag-grip CSS rules (G7 overlay-only styling)", () => {
    // Given: OVERLAY_LAYOUT_OVERRIDES from src/overlay/cssTransform.ts (imported at module level)
    // When:  the string value is checked for '.drag-grip {' rule
    // Then:  the rule is present (overlay-only — no .drag-grip in desktop Tauri topbar)
    assert.ok(
      OVERLAY_LAYOUT_OVERRIDES.includes(".drag-grip {"),
      "OVERLAY_LAYOUT_OVERRIDES must include '.drag-grip {' CSS rule (G7 overlay-only drag-grip styling). " +
        "If absent, the drag-grip dots have no visual style in the overlay shadow DOM.",
    );
    assert.ok(
      OVERLAY_LAYOUT_OVERRIDES.includes(".drag-grip-row {"),
      "OVERLAY_LAYOUT_OVERRIDES must include '.drag-grip-row {' CSS rule (G7 row layout).",
    );
    assert.ok(
      OVERLAY_LAYOUT_OVERRIDES.includes(".drag-grip-dot {"),
      "OVERLAY_LAYOUT_OVERRIDES must include '.drag-grip-dot {' CSS rule (G7 dot sizing).",
    );
  });
});

// ─── T-PY2MA.Hover.3 ────────────────────────────────────────────────────────

describe("T-PY2MA.Hover.3 — overlay handoff button text = 'Run on Auto'; desktop keeps 'Hand off to Auto' (G-PY2MA.10 / G9)", () => {
  it("T-PY2MA.Hover.3a: bootstrapShell.ts workflow-handoff-btn has textContent 'Run on Auto' (Sketch C §5.3.3)", () => {
    // Given: src/overlay/bootstrapShell.ts source post-builder (Sketch C §5.3.3 pasted)
    // When:  scanned for "Run on Auto" string
    // Then:  the string is present (FAILS pre-builder — current value is 'Hand off to Auto')
    const hasRunOnAuto = SHELL_TS.includes("Run on Auto");
    assert.ok(
      hasRunOnAuto,
      "bootstrapShell.ts #workflow-handoff-btn must have textContent 'Run on Auto' (G9 overlay-distinct label). " +
        "FAILS pre-builder — current value is 'Hand off to Auto' (Sketch C §5.3.3 not yet pasted).",
    );
  });

  it("T-PY2MA.Hover.3b: desktop index.html #workflow-handoff-btn still says 'Hand off to Auto' (desktop unchanged per G9)", () => {
    // Given: src/tauri/ui/index.html source
    // When:  scanned for 'Hand off to Auto' string (the desktop label, left unchanged by P-Y2-MA)
    // Then:  the string is present in index.html (desktop keeps the original label)
    const hasHandOff = INDEX_HTML.includes("Hand off to Auto");
    assert.ok(
      hasHandOff,
      "src/tauri/ui/index.html #workflow-handoff-btn must retain 'Hand off to Auto' (G9 — desktop unchanged). " +
        "If this fails post-builder, builder accidentally changed the desktop label.",
    );
  });
});
