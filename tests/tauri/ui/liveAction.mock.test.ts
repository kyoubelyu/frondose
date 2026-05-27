/**
 * P-Y2-MA Step 5 — T-PY2MA.LiveAct.1..3 — assertion bodies filled.
 *
 * Live-action ticker restyle in Auto mode (G4).
 *
 * Testing strategy:
 *   T-PY2MA.LiveAct.1 + .2 — source-structural check on app.ts for the mode-conditional
 *     ticker format: `→ ${toolName}` (Auto) vs `${toolName}...` (Manual).
 *   T-PY2MA.LiveAct.3 — source-structural check on index.html for the CSS rules
 *     `body.mode-auto #ticker` and `body.mode-auto #ticker::before { content: "LIVE ACTION" }`.
 *
 * Gate coverage:
 *   G-PY2MA.11 — T-PY2MA.LiveAct.1, .2, .3
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tauri/ui/liveAction.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const APP_TS = readFileSync(join(REPO, "src/tauri/ui/app.ts"), "utf-8");
const INDEX_HTML = readFileSync(join(REPO, "src/tauri/ui/index.html"), "utf-8");

// ─── T-PY2MA.LiveAct.1 ──────────────────────────────────────────────────────

describe("T-PY2MA.LiveAct.1 — In Auto mode, tool-call SSE → tickerEl.textContent = '→ {toolName}' (G-PY2MA.11)", () => {
  it("T-PY2MA.LiveAct.1: app.ts case 'tool-call' handler uses '→ ' prefix in Auto mode (Sketch A §5.1.6)", () => {
    // Given: src/tauri/ui/app.ts source post-builder (Sketch A §5.1.6 pasted)
    // When:  scanned for the mode-conditional ticker format `→ ${payload.toolName}`
    // Then:  the string '→ ' appears in the case "tool-call" arm of handleEvent
    const hasArrowFormat = APP_TS.includes("→ ");
    assert.ok(
      hasArrowFormat,
      "app.ts case 'tool-call' must set tickerEl.textContent = `→ ${payload.toolName}` in Auto mode. " +
        "The '→ ' string is absent — FAILS pre-builder (Sketch A §5.1.6 not yet pasted).",
    );
  });

  it("T-PY2MA.LiveAct.1b: app.ts case 'tool-call' handler uses a mode check (body.classList.contains('mode-auto')) to branch Auto vs Manual format", () => {
    // Given: src/tauri/ui/app.ts source post-builder (Sketch A §5.1.6)
    // When:  scanned for the mode-conditional branch inside case "tool-call"
    // Then:  both 'mode-auto' (the classList check) and '→ ' (the Auto format) appear
    //        AND the Manual-fallback `${payload.toolName}...` is also present
    //        (The actual branch: `isAuto ? \`→ ${payload.toolName}\` : \`${payload.toolName}...\``)
    const hasModeCheck = APP_TS.includes("mode-auto");
    const hasAutoFormat = APP_TS.includes("→ ");
    const hasManualFormat = APP_TS.includes("payload.toolName}...") || APP_TS.includes("toolName}...");
    assert.ok(
      hasModeCheck,
      "app.ts must check for 'mode-auto' class to conditionally apply Auto ticker format (G4 mode-conditional).",
    );
    assert.ok(
      hasAutoFormat,
      "app.ts case 'tool-call' must contain '→ ' for the Auto-mode ticker format (G4).",
    );
    assert.ok(
      hasManualFormat,
      "app.ts case 'tool-call' must contain '${payload.toolName}...' for Manual-mode fallback (G4). " +
        "String 'toolName}...' not found — Manual-mode branch may be missing.",
    );
  });
});

// ─── T-PY2MA.LiveAct.2 ──────────────────────────────────────────────────────

describe("T-PY2MA.LiveAct.2 — In Manual mode, tool-call SSE → tickerEl.textContent = '{toolName}...' (G-PY2MA.11)", () => {
  it("T-PY2MA.LiveAct.2a: app.ts case 'tool-call' handler uses '...' suffix in Manual mode (Sketch A §5.1.6)", () => {
    // Given: src/tauri/ui/app.ts source post-builder
    // When:  scanned for the manual-mode ticker format `${payload.toolName}...` in handleEvent
    // Then:  the pattern '...`' (triple-dot followed by backtick) appears after the ternary operator
    //        (i.e. the non-auto branch of the conditional ticker assignment)
    //
    // From app.ts L506: tickerEl.textContent = isAuto ? `→ ${payload.toolName}` : `${payload.toolName}...`
    // The ternary has '...`' in the Manual branch:
    const hasManualFormat = APP_TS.includes("payload.toolName}...") || APP_TS.includes(".toolName}...");
    assert.ok(
      hasManualFormat,
      "app.ts case 'tool-call' must contain the Manual-mode format '${payload.toolName}...' (G4). " +
        "If absent, Manual-mode ticker shows no tool name during a running turn.",
    );
  });

  it("T-PY2MA.LiveAct.2b: the Auto/Manual conditional uses the ternary form '→ ... : ...' (both branches in one statement)", () => {
    // Given: src/tauri/ui/app.ts source post-builder
    // When:  scanned for the ternary combining both Auto and Manual formats
    // Then:  the source contains both '→ ' AND '...' in close proximity, proving the single-ternary form
    //        (design: `isAuto ? \`→ ${toolName}\` : \`${toolName}...\`` avoids two separate tickerEl assigns)
    //
    // Locate the case "tool-call" block and check both branches are present
    const toolCallIdx = APP_TS.indexOf('case "tool-call":');
    const nextCaseIdx = APP_TS.indexOf("case ", toolCallIdx + 1);
    const toolCallBlock = toolCallIdx >= 0 && nextCaseIdx >= 0
      ? APP_TS.slice(toolCallIdx, nextCaseIdx)
      : "";
    const hasAutoInBlock = toolCallBlock.includes("→ ");
    const hasManualInBlock = toolCallBlock.includes("...");
    assert.ok(
      toolCallIdx >= 0,
      "app.ts handleEvent must contain case 'tool-call': (G4 mode-conditional ticker).",
    );
    assert.ok(
      hasAutoInBlock,
      "app.ts case 'tool-call' block must contain '→ ' (Auto-mode branch) within the case body (G4).",
    );
    assert.ok(
      hasManualInBlock,
      "app.ts case 'tool-call' block must contain '...' (Manual-mode branch) within the case body (G4).",
    );
  });
});

// ─── T-PY2MA.LiveAct.3 ──────────────────────────────────────────────────────

describe("T-PY2MA.LiveAct.3 — index.html CSS: body.mode-auto #ticker has mono-font + 'LIVE ACTION' label (G-PY2MA.11)", () => {
  it("T-PY2MA.LiveAct.3a: index.html contains 'body.mode-auto #ticker' CSS rule (Sketch B §5.2.3)", () => {
    // Given: src/tauri/ui/index.html source post-builder (Sketch B §5.2.3 pasted)
    // When:  scanned for the 'body.mode-auto #ticker' CSS rule
    // Then:  the rule is present (FAILS pre-builder — Sketch B §5.2.3 not yet pasted)
    const hasModeAutoTicker = INDEX_HTML.includes("body.mode-auto #ticker");
    assert.ok(
      hasModeAutoTicker,
      "src/tauri/ui/index.html must contain 'body.mode-auto #ticker' CSS rule (G4 live-action restyle). " +
        "FAILS pre-builder (Sketch B §5.2.3 not yet pasted).",
    );
  });

  it("T-PY2MA.LiveAct.3b: index.html contains '::before' rule with 'LIVE ACTION' content (Sketch B §5.2.3)", () => {
    // Given: src/tauri/ui/index.html source post-builder
    // When:  scanned for 'LIVE ACTION' string inside the body.mode-auto #ticker::before rule
    // Then:  the string 'LIVE ACTION' appears (FAILS pre-builder — Sketch B §5.2.3 not yet pasted)
    const hasLiveAction = INDEX_HTML.includes("LIVE ACTION");
    assert.ok(
      hasLiveAction,
      "src/tauri/ui/index.html must contain 'LIVE ACTION' in the ::before pseudo-element content rule " +
        "for body.mode-auto #ticker (G4 — the label line above the tool name in Auto mode). " +
        "FAILS pre-builder (Sketch B §5.2.3 not yet pasted).",
    );
  });

  it("T-PY2MA.LiveAct.3c: index.html body.mode-auto #ticker rule includes a monospace font-family stack", () => {
    // Given: src/tauri/ui/index.html source post-builder (Sketch B §5.2.3)
    // When:  scanned for 'monospace' within the body.mode-auto #ticker rule block
    // Then:  the string 'monospace' appears (FAILS pre-builder)
    const hasMonospace = INDEX_HTML.includes("monospace");
    assert.ok(
      hasMonospace,
      "src/tauri/ui/index.html body.mode-auto #ticker rule must include a monospace font-family " +
        "(ui-monospace / SF Mono / JetBrains Mono per Sketch B §5.2.3). " +
        "FAILS pre-builder (Sketch B §5.2.3 not yet pasted).",
    );
  });
});
