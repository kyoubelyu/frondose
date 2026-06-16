/**
 * P-57a Step 5 — T-Overlay.6, T-Overlay.7, T-Overlay.8, T-Overlay.9 — FILLED
 * (G-P57a.7, G-P57a.8, G-P57a.9, G-P57a.10)
 *
 * Mock tests for P-57a additions to `src/overlay/inject.ts` OVERLAY_BOOTSTRAP_JS:
 *   T-Overlay.6 — Trusted Types safety
 *   T-Overlay.7 — 7 new P-57a window functions + SPA detectors
 *   T-Overlay.8 — Pill click dispatches activate vs expand-dialog by URL
 *   T-Overlay.9 — Dialog #input keydown Enter emits 'prompt' event
 *
 * Gate coverage:
 *   G-P57a.7  — Overlay JS uses ONLY safe DOM API (T-Overlay.6)
 *   G-P57a.8  — Overlay defines all P-57a window functions + SPA detectors (T-Overlay.7)
 *   G-P57a.9  — Pill click URL-path dispatcher (T-Overlay.8)
 *   G-P57a.10 — Dialog #input Enter → prompt event (T-Overlay.9; also T-Tauri.LIVE.8)
 *
 * Mock strategy:
 *   - Pure string-grep against OVERLAY_BOOTSTRAP_JS exported constant.
 *   - No Chrome, no DOM, no LinkedIn.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/overlay/inject-p57a.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OVERLAY_BOOTSTRAP_JS } from "../../src/overlay/inject.js";

// ─── T-Overlay.6 — Trusted Types safety ──────────────────────────────────────

describe("OVERLAY_BOOTSTRAP_JS — ONLY safe DOM API; ZERO innerHTML/outerHTML/insertAdjacentHTML (G-P57a.7)", () => {
  it("T-Overlay.6: given OVERLAY_BOOTSTRAP_JS imported, WHEN grep applied for unsafe HTML APIs, THEN string contains 'document.createElement(' + '.textContent =' + '.appendChild(' + 'style.cssText' AND does NOT contain '.innerHTML' / '.outerHTML' / '.insertAdjacentHTML' anywhere", () => {
    // Given: OVERLAY_BOOTSTRAP_JS is the P-57a-extended exported constant per plan §5.5
    // When:  apply substring searches for safe-API presence + unsafe-API absence
    // Then:  all 4 safe APIs present; all 3 unsafe APIs absent

    assert.ok(
      typeof OVERLAY_BOOTSTRAP_JS === "string" && OVERLAY_BOOTSTRAP_JS.length > 0,
      "OVERLAY_BOOTSTRAP_JS must be a non-empty exported string",
    );

    // (a-d) Safe APIs present
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("document.createElement("),
      "(a) must contain 'document.createElement(' (constructor pattern)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes(".textContent ="),
      "(b) must contain '.textContent =' (safe text assignment)",
    );
    assert.ok(OVERLAY_BOOTSTRAP_JS.includes(".appendChild("), "(c) must contain '.appendChild(' (DOM tree assembly)");
    assert.ok(OVERLAY_BOOTSTRAP_JS.includes("style.cssText"), "(d) must contain 'style.cssText' (style assignment)");

    // (e-g) Unsafe APIs absent (Trusted Types CSP enforcement)
    assert.ok(
      !OVERLAY_BOOTSTRAP_JS.includes(".innerHTML"),
      "(e) must NOT contain '.innerHTML' anywhere (TT violation)",
    );
    assert.ok(!OVERLAY_BOOTSTRAP_JS.includes(".outerHTML"), "(f) must NOT contain '.outerHTML' anywhere");
    assert.ok(
      !OVERLAY_BOOTSTRAP_JS.includes("insertAdjacentHTML"),
      "(g) must NOT contain 'insertAdjacentHTML' anywhere",
    );
  });
});

// ─── T-Overlay.7 — 7 new window functions + SPA detectors ────────────────────

describe("OVERLAY_BOOTSTRAP_JS — defines 7 new P-57a window functions + MutationObserver + popstate (G-P57a.8)", () => {
  it("T-Overlay.7: given OVERLAY_BOOTSTRAP_JS imported, WHEN substring grep applied, THEN contains all 7 P-57a window functions (__frondoseExpandDialog, __frondoseCollapseDialog, __frondoseShowCard, __frondoseHideCard, __frondoseShowNextActions, __frondoseAppendOutput, __frondoseClearOutput) AND contains 'MutationObserver' (title detect) AND contains 'popstate' listener", () => {
    // Given: OVERLAY_BOOTSTRAP_JS as P-57a-extended constant
    // When:  substring grep for each window function declaration + SPA detectors
    // Then:  all 7 P-57a window functions present + MutationObserver + popstate

    const windowFns = [
      "window.__frondoseExpandDialog = function",
      "window.__frondoseCollapseDialog = function",
      "window.__frondoseShowCard = function",
      "window.__frondoseHideCard = function",
      "window.__frondoseShowNextActions = function",
      "window.__frondoseAppendOutput = function",
      "window.__frondoseClearOutput = function",
    ];
    for (const decl of windowFns) {
      assert.ok(OVERLAY_BOOTSTRAP_JS.includes(decl), `must contain "${decl}" per plan §5.5`);
    }

    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("MutationObserver"),
      "must contain 'MutationObserver' (title-element observer per §5.5)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("popstate"),
      "must contain 'popstate' (SPA route-change listener per §5.5)",
    );
  });
});

// ─── T-Overlay.8 — Pill click dispatches by URL path ─────────────────────────

describe("OVERLAY_BOOTSTRAP_JS — pill click handler dispatches activate vs expand-dialog by URL path (G-P57a.9)", () => {
  it("T-Overlay.8: given OVERLAY_BOOTSTRAP_JS imported, WHEN grep applied, THEN contains pill click registration AND the profile regex source AND 'activate' event-type literal AND 'expand-dialog' event-type literal", () => {
    // Given: OVERLAY_BOOTSTRAP_JS as P-57a-extended constant
    // When:  substring grep for click registration + profile regex + branch literals
    // Then:  all 4 substrings present

    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("pill.addEventListener('click'"),
      "(a) must contain pill click registration: pill.addEventListener('click'",
    );
    // Profile regex pattern in template literal: /^\\/in\\/([^/]+)\\/?$/
    // (template literal `\\/` produces `\/` in the runtime string)
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("/^\\/in\\/"),
      "(b) must contain profile regex source '/^\\/in\\/' (regex for /^\\/in\\/([^/]+)\\/?$/)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("'activate'"),
      "(c) must contain 'activate' literal (event_type for profile click)",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("'expand-dialog'"),
      "(d) must contain 'expand-dialog' literal (event_type for non-profile click)",
    );
  });
});

// ─── T-Overlay.9 — Dialog input Enter emits prompt event ─────────────────────

describe("OVERLAY_BOOTSTRAP_JS — dialog #input keydown Enter emits {type:'prompt', text} via __frondosePost (G-P57a.10)", () => {
  it("T-Overlay.9: given OVERLAY_BOOTSTRAP_JS imported, WHEN grep applied, THEN contains 'input.addEventListener(\\'keydown\\'' AND contains \"e.key === 'Enter'\" AND contains 'prompt' event-type literal AND contains '__frondosePost(' invocation", () => {
    // Given: OVERLAY_BOOTSTRAP_JS as P-57a-extended constant (post F-REN-5 rebrand)
    // When:  substring grep for input keydown handler + Enter check + post call
    // Then:  all 4 substrings present

    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("input.addEventListener('keydown'"),
      "(a) must contain input keydown registration: input.addEventListener('keydown'",
    );
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("e.key === 'Enter'"),
      "(b) must contain Enter key check: e.key === 'Enter'",
    );
    assert.ok(OVERLAY_BOOTSTRAP_JS.includes("'prompt'"), "(c) must contain 'prompt' literal (event_type)");
    // The post() helper invokes window.__frondosePost(json); test for `__frondosePost(` substring (F-REN-5 renamed from __maiPost).
    assert.ok(
      OVERLAY_BOOTSTRAP_JS.includes("__frondosePost("),
      "(d) must contain '__frondosePost(' invocation (the post() helper calls window.__frondosePost — renamed by F-REN-5)",
    );
  });
});
